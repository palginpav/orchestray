; Aider-style tag queries for Go (tree-sitter-go)
; Source: lifted verbatim from Aider's aider/queries/tree-sitter-go-tags.scm
; Aider repo: https://github.com/Aider-AI/aider — Apache-2.0 License
; Pinned per W1 research; copy maintained in Orchestray under bin/_lib/repo-map-grammars/queries/.

(
  (function_declaration
    name: (identifier) @name.definition.function) @definition.function
)

(
  (method_declaration
    name: (field_identifier) @name.definition.method) @definition.method
)

(call_expression
  function: [
    (identifier) @name.reference.call
    (parenthesized_expression (identifier) @name.reference.call)
    (selector_expression field: (field_identifier) @name.reference.call)
    (parenthesized_expression (selector_expression field: (field_identifier) @name.reference.call))
  ]) @reference.call

(type_spec
  name: (type_identifier) @name.definition.type) @definition.type

(type_identifier) @name.reference.type @reference.type
