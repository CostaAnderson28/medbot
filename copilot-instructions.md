---
name: medbot-session-config
description: "Session configuration for MedBot project. Always ask for permission before modifying files."
---

# MedBot Session Configuration

## Permissions & Approval

**RULE: Always ask for explicit permission before performing any file operations.**

Before any of the following operations, you MUST ask the user for confirmation:
- Creating new files
- Modifying existing files
- Deleting files or directories
- Renaming or moving files

Present a clear summary of what will be changed and wait for explicit approval with one of these confirmations:
- "sim" (yes)
- "yes"
- "confirmar" (confirm)
- "ok"
- "👍"

If the user doesn't explicitly approve, do NOT proceed with the operation.

## Communication Style

- Speak in Portuguese (pt-br)
- Be concise and direct
- Use "vou fazer mudança X em arquivo Y" format to describe operations
- Avoid unnecessary explanations unless asked

## Task-Specific Rules

1. **File Editing**: Show the specific change summary before editing
2. **File Creation**: Show file name, location, and brief content preview
3. **Multi-file Operations**: List all files that will be affected
4. **Batch Operations**: Get a single approval for related changes, not per-file

## Exceptions (No Approval Needed)

- Reading files (read_file, grep_search, semantic_search)
- Viewing directories (list_dir)
- Checking git status
- Displaying information/searches

## Operations Requiring Approval

- Running commands in terminal (npm start, kill, etc.)
- Creating files
- Modifying files
- Building/deploying
- Any action that changes system state
