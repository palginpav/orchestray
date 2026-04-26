; Aider-style tag queries for Bash (tree-sitter-bash)
; Source: lifted verbatim from Aider's aider/queries/tree-sitter-bash-tags.scm
; Aider repo: https://github.com/Aider-AI/aider — Apache-2.0 License
; Pinned per W1 research; copy maintained in Orchestray under bin/_lib/repo-map-grammars/queries/.

(function_definition
  name: (word) @name.definition.function) @definition.function

(command
  name: (command_name) @name.reference.call) @reference.call
