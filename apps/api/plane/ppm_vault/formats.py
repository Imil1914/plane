"""File-format vocabulary shared by Vault upload validation and server previews (AF2.1)."""

# Office Open XML formats whose preview is built on the server from the archive content.
OFFICE_PREVIEW_EXTENSIONS = frozenset({"docx", "xlsx", "pptx"})

# Source code and configuration stored as plain UTF-8 text. Browser-active markup
# (html, htm, xhtml, xml, svg) is deliberately absent: it is never accepted as "code".
CODE_TEXT_EXTENSIONS = frozenset(
    {
        "bash",
        "c",
        "cc",
        "cfg",
        "cjs",
        "cpp",
        "cs",
        "css",
        "cxx",
        "dart",
        "go",
        "gql",
        "graphql",
        "h",
        "hpp",
        "ini",
        "java",
        "jl",
        "js",
        "jsx",
        "kt",
        "kts",
        "less",
        "log",
        "lua",
        "mjs",
        "php",
        "proto",
        "ps1",
        "py",
        "r",
        "rb",
        "rs",
        "scala",
        "scss",
        "sh",
        "sql",
        "swift",
        "tex",
        "toml",
        "ts",
        "tsv",
        "tsx",
        "yaml",
        "yml",
        "zsh",
    }
)

# Extensions whose preview is the (size-capped) text itself.
TEXT_PREVIEW_EXTENSIONS = frozenset({"csv", "json", "md", "txt"}) | CODE_TEXT_EXTENSIONS
