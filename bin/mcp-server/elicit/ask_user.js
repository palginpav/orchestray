'use strict';

/**
 * `ask_user` tool handler.
 *
 * See CHANGELOG.md §2.0.11 (Stage 1 MCP surface) for design context. Pure handler: depends
 * only on its `context` argument for side effects (elicitation transport,
 * audit sink). The server wires the real `sendElicitation` and `auditSink`
 * at spawn time; tests inject fakes.
 *
 * Contract:
 *   async handleAskUser(input, context) -> {
 *     isError: boolean,
 *     content: [{ type: "text", text: string }],
 *     structuredContent?: object
 *   }
 *
 *   context = {
 *     sendElicitation: (params, timeoutMs) => Promise<{ action, content? }>,
 *     auditSink: (event) => void,
 *     config: object,
 *   }
 *
 * Decision rules (§3.4):
 *   1. Validate input.                 fail -> isError: true  (no sendElicitation)
 *   2. Translate form -> requestedSchema; defensive validate.
 *   3. Resolve timeout (ms).
 *   4. await sendElicitation({message, requestedSchema}, timeoutMs).
 *   5. Timeout reject (err.code === 'TIMEOUT')
 *      -> structuredContent { cancelled:false, timedOut:true }, outcome 'timeout'.
 *   6. action 'accept' -> { cancelled:false, ...content },     outcome 'answered'.
 *   7. action 'cancel' -> { cancelled:true },                   outcome 'cancelled'.
 *      action 'decline' -> { cancelled:true },                  outcome 'declined'.
 *   8. Any unexpected throw -> isError: true,                   outcome 'error'.
 *
 * Every code path emits exactly one audit event via context.auditSink.
 * The handler is total — no exception escapes.
 */

const {
  validateAskUserInput,
  validateElicitationRequestedSchema,
} = require('../lib/schemas');
const { buildAuditEvent } = require('../lib/audit');
const { checkLimit, recordSuccess } = require('../lib/tool-counts');

const AUDIT_TOOL_NAME = 'ask_user';
const DEFAULT_TIMEOUT_SECONDS = 120;

// ---------------------------------------------------------------------------
// Public handler
// ---------------------------------------------------------------------------

async function handleAskUser(input, context) {
  const startedAt = Date.now();
  const sendElicitation = (context && context.sendElicitation) || defaultSendElicitation;
  const auditSink = (context && context.auditSink) || noopAuditSink;
  const config = (context && context.config) || {};

  // -------------------------------------------------------------------------
  // 1. Validate input
  // -------------------------------------------------------------------------
  const validation = validateAskUserInput(input);
  if (!validation.ok) {
    emitAudit(auditSink, {
      outcome: 'error',
      duration_ms: Date.now() - startedAt,
      form_fields_count: readFormCountSafe(input),
    });
    const msg = 'ask_user: input validation failed: ' + validation.errors.join('; ');
    return toolError(msg);
  }

  const formFieldsCount = input.form.length;

  // -------------------------------------------------------------------------
  // 1b. W6 (v2.0.16): per-(orchestration_id, task_id) rate-limit pre-check.
  //     checkLimit is read-only — it does NOT increment the counter.
  //     recordSuccess is called only on outcome === 'answered' (accept branch).
  //     Only enforced when both ids are present and a projectRoot is available.
  // -------------------------------------------------------------------------
  const orchId = (input && typeof input.orchestration_id === 'string') ? input.orchestration_id : null;
  const taskId = (input && typeof input.task_id === 'string') ? input.task_id : null;
  const projectRoot = (context && context.projectRoot) || null;
  if (orchId && taskId && projectRoot) {
    const limitResult = checkLimit(
      { orchestration_id: orchId, task_id: taskId, tool_name: 'ask_user' },
      projectRoot,
      config
    );
    if (limitResult.exceeded) {
      emitAudit(auditSink, {
        outcome: 'error',
        duration_ms: Date.now() - startedAt,
        form_fields_count: formFieldsCount,
      });
      return toolError(
        'ask_user: max_per_task rate limit exceeded for task "' + taskId +
        '" (' + limitResult.count + '/' + limitResult.maxAllowed + ' calls used)'
      );
    }
  }

  // -------------------------------------------------------------------------
  // 2. Translate form[] -> MCP requestedSchema, defensively validate
  // -------------------------------------------------------------------------
  const requestedSchema = toElicitationSchema(input.form);
  const schemaCheck = validateElicitationRequestedSchema(requestedSchema);
  if (!schemaCheck.ok) {
    emitAudit(auditSink, {
      outcome: 'error',
      duration_ms: Date.now() - startedAt,
      form_fields_count: formFieldsCount,
    });
    return toolError(
      'ask_user: internal translated schema failed validation: ' + schemaCheck.errors.join('; ')
    );
  }

  // -------------------------------------------------------------------------
  // 3. Resolve timeout (ms)
  // -------------------------------------------------------------------------
  const timeoutSeconds = resolveTimeoutSeconds(input, config);
  const timeoutMs = timeoutSeconds * 1000;

  // -------------------------------------------------------------------------
  // 4. Send elicitation and await response
  // -------------------------------------------------------------------------
  const message = buildElicitationMessage(input.title, input.question);

  let elicitResult;
  try {
    elicitResult = await sendElicitation(
      { message, requestedSchema },
      timeoutMs
    );
  } catch (err) {
    // -----------------------------------------------------------------------
    // 5. Timeout branch
    // -----------------------------------------------------------------------
    if (err && err.code === 'TIMEOUT') {
      emitAudit(auditSink, {
        outcome: 'timeout',
        duration_ms: Date.now() - startedAt,
        form_fields_count: formFieldsCount,
      });
      return toolSuccess({ cancelled: false, timedOut: true });
    }

    // -----------------------------------------------------------------------
    // 8. Unexpected transport error
    // -----------------------------------------------------------------------
    emitAudit(auditSink, {
      outcome: 'error',
      duration_ms: Date.now() - startedAt,
      form_fields_count: formFieldsCount,
    });
    const msg =
      'ask_user: elicitation transport error: ' +
      (err && err.message ? err.message : String(err));
    return toolError(msg);
  }

  // -------------------------------------------------------------------------
  // 6 / 7. Inspect client response
  // -------------------------------------------------------------------------
  const action = classifyAction(elicitResult);

  if (action === 'accept') {
    const answers = (elicitResult && elicitResult.content) || {};
    emitAudit(auditSink, {
      outcome: 'answered',
      duration_ms: Date.now() - startedAt,
      form_fields_count: formFieldsCount,
    });
    // W6 (F06): record successful call only on 'answered' outcome.
    if (orchId && taskId && projectRoot) {
      recordSuccess(
        { orchestration_id: orchId, task_id: taskId, tool_name: 'ask_user' },
        projectRoot,
        config
      );
    }
    return toolSuccess({ cancelled: false, ...answers });
  }

  if (action === 'cancel') {
    emitAudit(auditSink, {
      outcome: 'cancelled',
      duration_ms: Date.now() - startedAt,
      form_fields_count: formFieldsCount,
    });
    return toolSuccess({ cancelled: true });
  }

  if (action === 'decline') {
    emitAudit(auditSink, {
      outcome: 'declined',
      duration_ms: Date.now() - startedAt,
      form_fields_count: formFieldsCount,
    });
    return toolSuccess({ cancelled: true });
  }

  // Unknown action — treat as error branch.
  emitAudit(auditSink, {
    outcome: 'error',
    duration_ms: Date.now() - startedAt,
    form_fields_count: formFieldsCount,
  });
  return toolError(
    'ask_user: unexpected elicitation action: ' +
      JSON.stringify(elicitResult && elicitResult.action)
  );
}

// ---------------------------------------------------------------------------
// Helpers (exported for tests / server reuse)
// ---------------------------------------------------------------------------

/**
 * Translate the `form[]` input array into a flat MCP elicitation
 * `requestedSchema`. Only primitive types; no nesting. `select` becomes
 * `type: "string"` with an `enum`.
 */
function toElicitationSchema(form) {
  const properties = {};
  const required = [];

  for (const field of form) {
    const prop = { description: field.label };

    switch (field.type) {
      case 'text':
        prop.type = 'string';
        break;
      case 'boolean':
        prop.type = 'boolean';
        break;
      case 'number':
        prop.type = 'number';
        break;
      case 'select':
        prop.type = 'string';
        if (Array.isArray(field.choices)) {
          prop.enum = field.choices.slice();
        }
        break;
      default:
        // Should have been rejected in validation; fall back to string.
        prop.type = 'string';
        break;
    }

    if ('default' in field && field.default !== undefined) {
      prop.default = field.default;
    }

    properties[field.name] = prop;
    if (field.required === true) {
      required.push(field.name);
    }
  }

  const schema = { type: 'object', properties };
  if (required.length > 0) {
    schema.required = required;
  }
  return schema;
}

/**
 * Classify a raw elicitation response into one of the four recognized
 * actions, or `null` if the response is malformed.
 */
function classifyAction(result) {
  if (!result || typeof result !== 'object') return null;
  const a = result.action;
  if (a === 'accept' || a === 'cancel' || a === 'decline') return a;
  return null;
}

function buildElicitationMessage(title, question) {
  // title and question are already validated as strings by validateAskUserInput.
  return title + '\n\n' + question;
}

function resolveTimeoutSeconds(input, config) {
  if (
    input &&
    typeof input.timeout_seconds === 'number' &&
    Number.isInteger(input.timeout_seconds)
  ) {
    return input.timeout_seconds;
  }
  const fromConfig =
    config &&
    config.mcp_server &&
    config.mcp_server.tools &&
    config.mcp_server.tools.ask_user &&
    config.mcp_server.tools.ask_user.default_timeout_seconds;
  if (typeof fromConfig === 'number' && Number.isInteger(fromConfig)) {
    return fromConfig;
  }
  return DEFAULT_TIMEOUT_SECONDS;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function readFormCountSafe(input) {
  if (input && Array.isArray(input.form)) return input.form.length;
  return 0;
}

function emitAudit(sink, { outcome, duration_ms, form_fields_count }) {
  try {
    const event = buildAuditEvent({
      tool: AUDIT_TOOL_NAME,
      outcome,
      duration_ms,
      form_fields_count,
    });
    sink(event);
  } catch (err) {
    // Fail-open: a broken sink must never crash the handler.
    try {
      process.stderr.write(
        '[orchestray-mcp] auditSink threw: ' +
          (err && err.message ? err.message : String(err)) +
          '\n'
      );
    } catch (_e) {
      // Nothing left to do.
    }
  }
}

function toolSuccess(structuredContent) {
  return {
    isError: false,
    content: [
      { type: 'text', text: JSON.stringify(structuredContent) },
    ],
    structuredContent,
  };
}

function toolError(text) {
  return {
    isError: true,
    content: [{ type: 'text', text }],
  };
}

async function defaultSendElicitation() {
  const err = new Error('sendElicitation not provided in context');
  err.code = 'NO_TRANSPORT';
  throw err;
}

function noopAuditSink() {
  // Intentional no-op. The server wires the real sink; tests may inject one.
}

module.exports = {
  handleAskUser,
  toElicitationSchema,
  classifyAction,
  resolveTimeoutSeconds,
};
