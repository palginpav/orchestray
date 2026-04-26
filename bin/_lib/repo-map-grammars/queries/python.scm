; Aider-style tag queries for Python (tree-sitter-python)
; Source: lifted verbatim from Aider's aider/queries/tree-sitter-python-tags.scm
; Aider repo: https://github.com/Aider-AI/aider — Apache-2.0 License
; Pinned per W1 research; copy maintained in Orchestray under bin/_lib/repo-map-grammars/queries/.

(class_definition
  name: (identifier) @name.definition.class) @definition.class

(function_definition
  name: (identifier) @name.definition.function) @definition.function

(call
  function: [
    (identifier) @name.reference.call
    (attribute attribute: (identifier) @name.reference.call)
  ]) @reference.call
