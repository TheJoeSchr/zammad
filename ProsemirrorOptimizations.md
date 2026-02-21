# TipTap/ProseMirror Optimization Report

## Overview

This document analyzes the TipTap (ProseMirror wrapper) implementation in the Zammad frontend
and identifies faultlines, memory leaks, and optimization opportunities.

## Where ProseMirror is Used

The editor is implemented via **TipTap** (a ProseMirror wrapper) in:

| File | Purpose |
|------|---------|
| `FieldEditorInput.vue` | Main editor component using `useEditor` from `@tiptap/vue-3` |
| `FieldEditorWrapper.vue` | Async wrapper with suspense fallback |
| `extensions/*.ts` | Custom TipTap extensions (mentions, AI tools, signatures, etc.) |
| `utils.ts` | Selection handling, floating UI positioning |

### TipTap Dependencies

- `@tiptap/core` - Core editor functionality
- `@tiptap/pm` - ProseMirror integration layer
- `@tiptap/vue-3` - Vue 3 bindings
- `@tiptap/starter-kit` - Basic editor setup
- Various formatting extensions: bold, italic, tables, code blocks, etc.

---

## Faultlines Identified

### 1. Memory Leaks in `AiAssistantTextTools.ts`

**Severity:** High

**Problem:** Event listeners are added but not properly cleaned up:

