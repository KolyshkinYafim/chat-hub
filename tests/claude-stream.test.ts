import { describe, expect, it } from "vitest"
import { ClaudeActivityStream, mergeClaudeUsage } from "../src/main/adapters/claude"
import { safeJson, structuredPatchToDiff } from "../src/main/adapters/stream-parse"
import { readUsage } from "../src/main/adapters/usage"
import { describeItem } from "@renderer/lib/live-step"
import type { AgentTurnItem } from "../src/shared/types"

/**
 * Every line below was captured from real `claude -p … --output-format
 * stream-json --verbose --include-partial-messages` runs (Claude Code 2.1.205,
 * haiku) on 2026-08-26. Scratch paths were shortened to `/p`, very long strings
 * clipped, and the envelope fields nothing reads (`usage` outside the fixtures
 * that test it, `uuid`, `signature`, `request_id`, `stop_*`, `diagnostics`)
 * dropped — every field the adapter looks at is exactly as the CLI printed it.
 */

/** A Task call and the nested agent it spawned. The child's own assistant and
 * user lines ride the same stream, tagged with `parent_tool_use_id`; the CLI
 * narrates the child a second time under `task_started` / `task_progress` /
 * `task_notification`. */
const SUBAGENT = [
  "{\"type\":\"assistant\",\"message\":{\"model\":\"claude-haiku-4-5-20251001\",\"id\":\"msg_011CeS66qwY67q6tHmeU4KMC\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_0144Vq7LvuZ72wwZhoFJTtva\",\"name\":\"Agent\",\"input\":{\"description\":\"Read notes.txt and report first line\",\"subagent_type\":\"Explore\",\"prompt\":\"Read the file notes.txt and report only its first line. Just the first line, nothing else.\"},\"caller\":{\"type\":\"direct\"}}],\"usage\":{\"input_tokens\":10,\"cache_creation_input_tokens\":28458,\"cache_read_input_tokens\":0,\"cache_creation\":{\"ephemeral_5m_input_tokens\":0,\"ephemeral_1h_input_tokens\":28458},\"output_tokens\":4,\"inference_geo\":\"not_available\"}},\"parent_tool_use_id\":null,\"session_id\":\"991a2f0f-92dd-4164-857b-f62df6e5ade1\"}",
  "{\"type\":\"system\",\"subtype\":\"task_started\",\"task_id\":\"affd2fb629b051b2f\",\"tool_use_id\":\"toolu_0144Vq7LvuZ72wwZhoFJTtva\",\"description\":\"Read notes.txt and report first line\",\"subagent_type\":\"Explore\",\"task_type\":\"local_agent\",\"prompt\":\"Read the file notes.txt and report only its first line. Just the first line, nothing else.\",\"session_id\":\"991a2f0f-92dd-4164-857b-f62df6e5ade1\"}",
  "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"tool_use_id\":\"toolu_0144Vq7LvuZ72wwZhoFJTtva\",\"type\":\"tool_result\",\"content\":[{\"type\":\"text\",\"text\":\"Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)\\nagentId: affd2fb629b051b2f (int…\"}]}]},\"parent_tool_use_id\":null,\"session_id\":\"991a2f0f-92dd-4164-857b-f62df6e5ade1\",\"tool_use_result\":{\"isAsync\":true,\"status\":\"async_launched\",\"agentId\":\"affd2fb629b051b2f\",\"description\":\"Read notes.txt and report first line\",\"resolvedModel\":\"claude-haiku-4-5-20251001\",\"prompt\":\"Read the file notes.txt and report only its first line. Just the first line, nothing else.\",\"outputFile\":\"/p/tasks/affd2fb629b051b2f.output\",\"canReadOutputFile\":true}}",
  "{\"type\":\"assistant\",\"message\":{\"model\":\"claude-haiku-4-5-20251001\",\"id\":\"msg_011CeS67sT6cM1GVYdjutZZZ\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"thinking\",\"thinking\":\"The user is asking me to read a file called `notes.txt` and report only its first line. I need to find this file first. Let me start by looking for it.\\n\\nSince I'm in a read-only mode and the user is a…\"}],\"usage\":{\"input_tokens\":10,\"cache_creation_input_tokens\":10901,\"cache_read_input_tokens\":0,\"cache_creation\":{\"ephemeral_5m_input_tokens\":10901,\"ephemeral_1h_input_tokens\":0},\"output_tokens\":4,\"inference_geo\":\"not_available\"}},\"parent_tool_use_id\":\"toolu_0144Vq7LvuZ72wwZhoFJTtva\",\"session_id\":\"991a2f0f-92dd-4164-857b-f62df6e5ade1\",\"subagent_type\":\"Explore\",\"task_description\":\"Read notes.txt and report first line\"}",
  "{\"type\":\"assistant\",\"message\":{\"model\":\"claude-haiku-4-5-20251001\",\"id\":\"msg_011CeS67sT6cM1GVYdjutZZZ\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_01AzPXhMFAScRR3ssuSBTwwo\",\"name\":\"Glob\",\"input\":{\"pattern\":\"notes.txt\"},\"caller\":{\"type\":\"direct\"}}],\"usage\":{\"input_tokens\":10,\"cache_creation_input_tokens\":10901,\"cache_read_input_tokens\":0,\"cache_creation\":{\"ephemeral_5m_input_tokens\":10901,\"ephemeral_1h_input_tokens\":0},\"output_tokens\":4,\"inference_geo\":\"not_available\"}},\"parent_tool_use_id\":\"toolu_0144Vq7LvuZ72wwZhoFJTtva\",\"session_id\":\"991a2f0f-92dd-4164-857b-f62df6e5ade1\",\"subagent_type\":\"Explore\",\"task_description\":\"Read notes.txt and report first line\"}",
  "{\"type\":\"system\",\"subtype\":\"task_progress\",\"task_id\":\"affd2fb629b051b2f\",\"tool_use_id\":\"toolu_0144Vq7LvuZ72wwZhoFJTtva\",\"description\":\"Finding notes.txt\",\"subagent_type\":\"Explore\",\"usage\":{\"total_tokens\":10919,\"tool_uses\":1,\"duration_ms\":4368},\"last_tool_name\":\"Glob\",\"session_id\":\"991a2f0f-92dd-4164-857b-f62df6e5ade1\"}",
  "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"tool_use_id\":\"toolu_01AzPXhMFAScRR3ssuSBTwwo\",\"type\":\"tool_result\",\"content\":\"notes.txt\"}]},\"parent_tool_use_id\":\"toolu_0144Vq7LvuZ72wwZhoFJTtva\",\"session_id\":\"991a2f0f-92dd-4164-857b-f62df6e5ade1\",\"subagent_type\":\"Explore\",\"task_description\":\"Read notes.txt and report first line\"}",
  "{\"type\":\"assistant\",\"message\":{\"model\":\"claude-haiku-4-5-20251001\",\"id\":\"msg_011CeS68CKAh8uWywcnQbRo2\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"thinking\",\"thinking\":\"Good, I found notes.txt in the current directory. Now I need to read it and report only the first line.\"}],\"usage\":{\"input_tokens\":8,\"cache_creation_input_tokens\":443,\"cache_read_input_tokens\":10901,\"cache_creation\":{\"ephemeral_5m_input_tokens\":443,\"ephemeral_1h_input_tokens\":0},\"output_tokens\":1,\"inference_geo\":\"not_available\"}},\"parent_tool_use_id\":\"toolu_0144Vq7LvuZ72wwZhoFJTtva\",\"session_id\":\"991a2f0f-92dd-4164-857b-f62df6e5ade1\",\"subagent_type\":\"Explore\",\"task_description\":\"Read notes.txt and report first line\"}",
  "{\"type\":\"assistant\",\"message\":{\"model\":\"claude-haiku-4-5-20251001\",\"id\":\"msg_011CeS68CKAh8uWywcnQbRo2\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_019TEaCgiMGAETrxsQVDbwsw\",\"name\":\"Read\",\"input\":{\"file_path\":\"/p/notes.txt\",\"limit\":1},\"caller\":{\"type\":\"direct\"}}],\"usage\":{\"input_tokens\":8,\"cache_creation_input_tokens\":443,\"cache_read_input_tokens\":10901,\"cache_creation\":{\"ephemeral_5m_input_tokens\":443,\"ephemeral_1h_input_tokens\":0},\"output_tokens\":1,\"inference_geo\":\"not_available\"}},\"parent_tool_use_id\":\"toolu_0144Vq7LvuZ72wwZhoFJTtva\",\"session_id\":\"991a2f0f-92dd-4164-857b-f62df6e5ade1\",\"subagent_type\":\"Explore\",\"task_description\":\"Read notes.txt and report first line\"}",
  "{\"type\":\"system\",\"subtype\":\"task_progress\",\"task_id\":\"affd2fb629b051b2f\",\"tool_use_id\":\"toolu_0144Vq7LvuZ72wwZhoFJTtva\",\"description\":\"Reading notes.txt\",\"subagent_type\":\"Explore\",\"usage\":{\"total_tokens\":11362,\"tool_uses\":2,\"duration_ms\":6751},\"last_tool_name\":\"Read\",\"session_id\":\"991a2f0f-92dd-4164-857b-f62df6e5ade1\"}",
  "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"tool_use_id\":\"toolu_019TEaCgiMGAETrxsQVDbwsw\",\"type\":\"tool_result\",\"content\":\"1\\talpha\"}]},\"parent_tool_use_id\":\"toolu_0144Vq7LvuZ72wwZhoFJTtva\",\"session_id\":\"991a2f0f-92dd-4164-857b-f62df6e5ade1\",\"subagent_type\":\"Explore\",\"task_description\":\"Read notes.txt and report first line\"}",
  "{\"type\":\"assistant\",\"message\":{\"model\":\"claude-haiku-4-5-20251001\",\"id\":\"msg_011CeS68PDFaUa8sB89jGe98\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"thinking\",\"thinking\":\"Perfect! I've read the file and got the first line. The first line is \\\"alpha\\\". The user asked me to report only the first line, nothing else. So I should just say \\\"alpha\\\".\"}],\"usage\":{\"input_tokens\":8,\"cache_creation_input_tokens\":200,\"cache_read_input_tokens\":11344,\"cache_creation\":{\"ephemeral_5m_input_tokens\":200,\"ephemeral_1h_input_tokens\":0},\"output_tokens\":4,\"inference_geo\":\"not_available\"}},\"parent_tool_use_id\":\"toolu_0144Vq7LvuZ72wwZhoFJTtva\",\"session_id\":\"991a2f0f-92dd-4164-857b-f62df6e5ade1\",\"subagent_type\":\"Explore\",\"task_description\":\"Read notes.txt and report first line\"}",
  "{\"type\":\"assistant\",\"message\":{\"model\":\"claude-haiku-4-5-20251001\",\"id\":\"msg_011CeS68PDFaUa8sB89jGe98\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"alpha\"}],\"usage\":{\"input_tokens\":8,\"cache_creation_input_tokens\":200,\"cache_read_input_tokens\":11344,\"cache_creation\":{\"ephemeral_5m_input_tokens\":200,\"ephemeral_1h_input_tokens\":0},\"output_tokens\":4,\"inference_geo\":\"not_available\"}},\"parent_tool_use_id\":\"toolu_0144Vq7LvuZ72wwZhoFJTtva\",\"session_id\":\"991a2f0f-92dd-4164-857b-f62df6e5ade1\",\"subagent_type\":\"Explore\",\"task_description\":\"Read notes.txt and report first line\"}",
  "{\"type\":\"system\",\"subtype\":\"task_updated\",\"task_id\":\"affd2fb629b051b2f\",\"patch\":{\"status\":\"completed\",\"end_time\":1787780584194},\"session_id\":\"991a2f0f-92dd-4164-857b-f62df6e5ade1\"}",
  "{\"type\":\"system\",\"subtype\":\"task_notification\",\"task_id\":\"affd2fb629b051b2f\",\"tool_use_id\":\"toolu_0144Vq7LvuZ72wwZhoFJTtva\",\"status\":\"completed\",\"output_file\":\"/p/tasks/affd2fb629b051b2f.output\",\"summary\":\"alpha\",\"usage\":{\"total_tokens\":11570,\"tool_uses\":2,\"duration_ms\":8701},\"session_id\":\"991a2f0f-92dd-4164-857b-f62df6e5ade1\"}",
]

/** Extended thinking, a shell command that exits non-zero, an image the agent
 * read, and a file it wrote — one turn, in the order the CLI printed it. */
const THINKING_AND_TOOLS = [
  "{\"type\":\"stream_event\",\"event\":{\"type\":\"message_start\",\"message\":{\"model\":\"claude-haiku-4-5-20251001\",\"id\":\"msg_011CeS6ESkk2TceA4nDQkzfH\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[]}},\"session_id\":\"c46caed7-23ef-4868-8864-442443687437\",\"parent_tool_use_id\":null,\"ttft_ms\":926}",
  "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"The user is asking\",\"estimated_tokens\":null}},\"session_id\":\"c46caed7-23ef-4868-8864-442443687437\",\"parent_tool_use_id\":null}",
  "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\" me to:\\n1. Run `ls /definitely-missing-dir` with Bash\\n2. Read tiny.png with the Read tool\\n3. Write the word \\\"done\\\" into out.txt with\",\"estimated_tokens\":null}},\"session_id\":\"c46caed7-23ef-4868-8864-442443687437\",\"parent_tool_use_id\":null}",
  "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_01Gi5VRpF8qCEUX6KcyL7pp5\",\"name\":\"Bash\",\"input\":{},\"caller\":{\"type\":\"direct\"}}},\"session_id\":\"c46caed7-23ef-4868-8864-442443687437\",\"parent_tool_use_id\":null}",
  "{\"type\":\"assistant\",\"message\":{\"model\":\"claude-haiku-4-5-20251001\",\"id\":\"msg_011CeS6ESkk2TceA4nDQkzfH\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_01Gi5VRpF8qCEUX6KcyL7pp5\",\"name\":\"Bash\",\"input\":{\"command\":\"ls /definitely-missing-dir\",\"description\":\"List contents of /definitely-missing-dir\"},\"caller\":{\"type\":\"direct\"}}]},\"parent_tool_use_id\":null,\"session_id\":\"c46caed7-23ef-4868-8864-442443687437\"}",
  "{\"type\":\"assistant\",\"message\":{\"model\":\"claude-haiku-4-5-20251001\",\"id\":\"msg_011CeS6ESkk2TceA4nDQkzfH\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_01JGRP1L5M9BTKX3ZrJwFS8e\",\"name\":\"Read\",\"input\":{\"file_path\":\"tiny.png\"},\"caller\":{\"type\":\"direct\"}}]},\"parent_tool_use_id\":null,\"session_id\":\"c46caed7-23ef-4868-8864-442443687437\"}",
  "{\"type\":\"assistant\",\"message\":{\"model\":\"claude-haiku-4-5-20251001\",\"id\":\"msg_011CeS6ESkk2TceA4nDQkzfH\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_01EKXmkR26zZoCGyUY6gjLUm\",\"name\":\"Write\",\"input\":{\"file_path\":\"out.txt\",\"content\":\"done\"},\"caller\":{\"type\":\"direct\"}}]},\"parent_tool_use_id\":null,\"session_id\":\"c46caed7-23ef-4868-8864-442443687437\"}",
  "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"content\":\"Exit code 1\\nls: /definitely-missing-dir: No such file or directory\",\"is_error\":true,\"tool_use_id\":\"toolu_01Gi5VRpF8qCEUX6KcyL7pp5\"}]},\"parent_tool_use_id\":null,\"session_id\":\"c46caed7-23ef-4868-8864-442443687437\",\"tool_use_result\":\"Error: Exit code 1\\nls: /definitely-missing-dir: No such file or directory\"}",
  "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"tool_use_id\":\"toolu_01JGRP1L5M9BTKX3ZrJwFS8e\",\"type\":\"tool_result\",\"content\":[{\"type\":\"image\",\"source\":{\"type\":\"base64\",\"data\":\"iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFElEQVR4nGP8z8Dwn4GKgImahI0HQwCVpwINtGyKmAAAAABJRU5ErkJggg==\",\"media_type\":\"image/png\"}}]}]},\"parent_tool_use_id\":null,\"session_id\":\"c46caed7-23ef-4868-8864-442443687437\",\"tool_use_result\":{\"type\":\"image\",\"file\":{\"base64\":\"iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFElEQVR4nGP8z8Dwn4GKgImahI0HQwCVpwINtGyKmAAAAABJRU5ErkJggg==\",\"type\":\"image/png\",\"originalSize\":79}}}",
  "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"tool_use_id\":\"toolu_01EKXmkR26zZoCGyUY6gjLUm\",\"type\":\"tool_result\",\"content\":\"File created successfully at: out.txt (file state is current in your context — no need to Read it back)\"}]},\"parent_tool_use_id\":null,\"session_id\":\"c46caed7-23ef-4868-8864-442443687437\",\"tool_use_result\":{\"type\":\"create\",\"filePath\":\"out.txt\",\"content\":\"done\",\"structuredPatch\":[],\"originalFile\":null,\"userModified\":false}}",
]

/** An Edit whose result carries the CLI's own `structuredPatch`. */
const EDIT = [
  "{\"type\":\"assistant\",\"message\":{\"model\":\"claude-haiku-4-5-20251001\",\"id\":\"msg_011CeS6L4PW5zixj5mNqkMCP\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_014LaGcs1Hu5TcgyniCWUMEj\",\"name\":\"Read\",\"input\":{\"file_path\":\"/p/notes.txt\"},\"caller\":{\"type\":\"direct\"}}]},\"parent_tool_use_id\":null,\"session_id\":\"f8d992cb-0342-42e4-9ff3-114e46f38e87\"}",
  "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"tool_use_id\":\"toolu_014LaGcs1Hu5TcgyniCWUMEj\",\"type\":\"tool_result\",\"content\":\"1\\talpha\\n2\\tbeta\\n3\\tgamma\\n4\\t\"}]},\"parent_tool_use_id\":null,\"session_id\":\"f8d992cb-0342-42e4-9ff3-114e46f38e87\",\"tool_use_result\":{\"type\":\"text\",\"file\":{\"filePath\":\"/p/notes.txt\",\"content\":\"alpha\\nbeta\\ngamma\\n\",\"numLines\":4,\"startLine\":1,\"totalLines\":4}}}",
  "{\"type\":\"assistant\",\"message\":{\"model\":\"claude-haiku-4-5-20251001\",\"id\":\"msg_011CeS6LKjz2PXWKzbEieBq8\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_01DF9pmVKP3prbgYcC2ksGFc\",\"name\":\"Edit\",\"input\":{\"replace_all\":false,\"file_path\":\"/p/notes.txt\",\"old_string\":\"alpha\",\"new_string\":\"ALPHA\"},\"caller\":{\"type\":\"direct\"}}]},\"parent_tool_use_id\":null,\"session_id\":\"f8d992cb-0342-42e4-9ff3-114e46f38e87\"}",
  "{\"type\":\"assistant\",\"message\":{\"model\":\"claude-haiku-4-5-20251001\",\"id\":\"msg_011CeS6LKjz2PXWKzbEieBq8\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_01F34mKW72NwvKj8HXNgLAwb\",\"name\":\"Bash\",\"input\":{\"command\":\"echo hi\"},\"caller\":{\"type\":\"direct\"}}]},\"parent_tool_use_id\":null,\"session_id\":\"f8d992cb-0342-42e4-9ff3-114e46f38e87\"}",
  "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"tool_use_id\":\"toolu_01DF9pmVKP3prbgYcC2ksGFc\",\"type\":\"tool_result\",\"content\":\"The file /p/notes.txt has been updated successfully. (file state is current in your context — no need to Read it back)\"}]},\"parent_tool_use_id\":null,\"session_id\":\"f8d992cb-0342-42e4-9ff3-114e46f38e87\",\"tool_use_result\":{\"filePath\":\"/p/notes.txt\",\"oldString\":\"alpha\",\"newString\":\"ALPHA\",\"originalFile\":\"alpha\\nbeta\\ngamma\\n\",\"structuredPatch\":[{\"oldStart\":1,\"oldLines\":3,\"newStart\":1,\"newLines\":3,\"lines\":[\"-alpha\",\"+ALPHA\",\" beta\",\" gamma\"]}],\"userModified\":false,\"replaceAll\":false}}",
  "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"tool_use_id\":\"toolu_01F34mKW72NwvKj8HXNgLAwb\",\"type\":\"tool_result\",\"content\":\"hi\",\"is_error\":false}]},\"parent_tool_use_id\":null,\"session_id\":\"f8d992cb-0342-42e4-9ff3-114e46f38e87\",\"tool_use_result\":{\"stdout\":\"hi\",\"stderr\":\"\",\"interrupted\":false,\"isImage\":false,\"noOutputExpected\":false}}",
]

/** A WebSearch call and the links it came back with. */
const WEB_SEARCH = [
  "{\"type\":\"assistant\",\"message\":{\"model\":\"claude-haiku-4-5-20251001\",\"id\":\"msg_011CeS6LFcgbkJuVEmKoCTNG\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_01SFfxzePt5oNuLGYzvN7C69\",\"name\":\"WebSearch\",\"input\":{\"query\":\"node.js current LTS version\"},\"caller\":{\"type\":\"direct\"}}]},\"parent_tool_use_id\":null,\"session_id\":\"3c7a4ef7-e7f1-40b8-91f9-ff4f4da757aa\"}",
  "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"tool_use_id\":\"toolu_01SFfxzePt5oNuLGYzvN7C69\",\"type\":\"tool_result\",\"content\":\"Web search results for query: \\\"node.js current LTS version\\\"\\n\\nLinks: [{\\\"title\\\":\\\"Download & Update Node.js to the Latest Version! Node v26.5.1 Current / LTS v24.18.1 Direct Links - RisingStack Engineeri…\"}]},\"parent_tool_use_id\":null,\"session_id\":\"3c7a4ef7-e7f1-40b8-91f9-ff4f4da757aa\",\"tool_use_result\":{\"query\":\"node.js current LTS version\",\"results\":[{\"tool_use_id\":\"srvtoolu_01HKsQTRFnxSQyRSfAESnywB\",\"content\":[{\"title\":\"Download & Update Node.js to the Latest Version! Node v26.5.1 Current / LTS v24.18.1 Direct Links - RisingStack Engineering\",\"url\":\"https://blog.risingstack.com/update-node-js-latest-version/\"},{\"title\":\"Node.js — Node.js 24.14.0 (LTS)\",\"url\":\"https://nodejs.org/en/blog/release/v24.14.0\"},{\"title\":\"node-lts-versions - npm\",\"url\":\"https://www.npmjs.com/package/node-lts-versions\"},{\"title\":\"Node.js — Node.js Releases\",\"url\":\"https://nodejs.org/en/about/previous-releases\"},{\"title\":\"Node.js | endoflife.date\",\"url\":\"https://endoflife.date/nodejs\"},{\"title\":\"Node LTS versions - GitHub Marketplace\",\"url\":\"https://github.com/marketplace/actions/node-lts-versions\"},{\"title\":\"Node.js — Node.js 24.11.0 (LTS)\",\"url\":\"https://nodejs.org/en/blog/release/v24.11.0\"},{\"title\":\"GitHub - nodejs/Release: Node.js Release Working Group · GitHub\",\"url\":\"https://github.com/nodejs/Release\"},{\"title\":\"Node.js — Node.js 20.9.0 (LTS)\",\"url\":\"https://nodejs.org/en/blog/release/v20.9.0\"}]},\"Based on the search results, Node.js 24.x is currently in Long Term Support (LTS) with the codename 'Krypton' and will continue to receive updates through to the end of April 2028.\\n\\nAdditionally, Node…\"],\"durationSeconds\":3.3762896659999995,\"searchCount\":1}}",
]

/** `/compact` on a resumed session: the CLI announces the wait, then the boundary. */
const COMPACTION = [
  "{\"type\":\"system\",\"subtype\":\"status\",\"status\":\"compacting\",\"session_id\":\"f8d992cb-0342-42e4-9ff3-114e46f38e87\"}",
  "{\"type\":\"system\",\"subtype\":\"status\",\"status\":null,\"compact_result\":\"success\",\"session_id\":\"f8d992cb-0342-42e4-9ff3-114e46f38e87\"}",
  "{\"type\":\"system\",\"subtype\":\"compact_boundary\",\"session_id\":\"f8d992cb-0342-42e4-9ff3-114e46f38e87\",\"compact_metadata\":{\"trigger\":\"manual\",\"pre_tokens\":28885,\"post_tokens\":2535,\"cumulative_dropped_tokens\":26350,\"duration_ms\":21980,\"preserved_segment\":{\"head_uuid\":\"9e9470f4-474a-4abf-8cdb-ab899ee9fa91\",\"anchor_uuid\":\"243d5542-43b5-4606-b12a-1e6ddbcace70\",\"tail_uuid\":\"b5da5af9-a577-42b5-834f-f880cdf92771\"},\"preserved_messages\":{\"anchor_uuid\":\"243d5542-43b5-4606-b12a-1e6ddbcace70\",\"uuids\":[\"9e9470f4-474a-4abf-8cdb-ab899ee9fa91\",\"b5da5af9-a577-42b5-834f-f880cdf92771\"],\"all_uuids\":[\"9e9470f4-474a-4abf-8cdb-ab899ee9fa91\",\"b5da5af9-a577-42b5-834f-f880cdf92771\",\"fb24faf2-a625-4b36-9698-6b49fc755759\",\"2448d41b-fe74-4b39-8d79-3d04dfa2e148\"]}}}",
]

/** One process run, two `result` envelopes — an async subagent finishing makes
 * the CLI close a second internal turn before the process exits. */
const TWO_RESULTS = [
  "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"api_error_status\":null,\"duration_ms\":16806,\"duration_api_ms\":15591,\"ttft_ms\":13905,\"ttft_stream_ms\":1133,\"time_to_request_ms\":85,\"num_turns\":2,\"result\":\"The agent is reading notes.txt now. I'll report the first line once it completes.\",\"session_id\":\"991a2f0f-92dd-4164-857b-f62df6e5ade1\",\"total_cost_usd\":0.06928480000000001,\"usage\":{\"input_tokens\":18,\"cache_creation_input_tokens\":29988,\"cache_read_input_tokens\":28458,\"output_tokens\":1289,\"server_tool_use\":{\"web_search_requests\":0,\"web_fetch_requests\":0},\"cache_creation\":{\"ephemeral_1h_input_tokens\":29988,\"ephemeral_5m_input_tokens\":0},\"inference_geo\":\"not_available\",\"iterations\":[{\"input_tokens\":8,\"output_tokens\":95,\"cache_read_input_tokens\":28458,\"cache_creation_input_tokens\":1530,\"cache_creation\":{\"ephemeral_5m_input_tokens\":0,\"ephemeral_1h_input_tokens\":1530},\"type\":\"message\"}],\"speed\":\"standard\"},\"modelUsage\":{\"claude-haiku-4-5-20251001\":{\"inputTokens\":54,\"outputTokens\":1882,\"cacheReadInputTokens\":80691,\"cacheCreationInputTokens\":42938,\"webSearchRequests\":0,\"costUSD\":0.0947511,\"contextWindow\":200000,\"maxOutputTokens\":32000}},\"permission_denials\":[],\"terminal_reason\":\"completed\",\"fast_mode_state\":\"off\"}",
  "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"api_error_status\":null,\"duration_ms\":2945,\"duration_api_ms\":25672,\"ttft_ms\":1643,\"ttft_stream_ms\":837,\"time_to_request_ms\":56,\"num_turns\":1,\"result\":\"alpha\",\"session_id\":\"991a2f0f-92dd-4164-857b-f62df6e5ade1\",\"total_cost_usd\":0.0947511,\"usage\":{\"input_tokens\":10,\"cache_creation_input_tokens\":1406,\"cache_read_input_tokens\":29988,\"output_tokens\":65,\"server_tool_use\":{\"web_search_requests\":0,\"web_fetch_requests\":0},\"cache_creation\":{\"ephemeral_1h_input_tokens\":1406,\"ephemeral_5m_input_tokens\":0},\"inference_geo\":\"not_available\",\"iterations\":[{\"input_tokens\":10,\"output_tokens\":65,\"cache_read_input_tokens\":29988,\"cache_creation_input_tokens\":1406,\"cache_creation\":{\"ephemeral_5m_input_tokens\":0,\"ephemeral_1h_input_tokens\":1406},\"type\":\"message\"}],\"speed\":\"standard\"},\"modelUsage\":{\"claude-haiku-4-5-20251001\":{\"inputTokens\":54,\"outputTokens\":1882,\"cacheReadInputTokens\":80691,\"cacheCreationInputTokens\":42938,\"webSearchRequests\":0,\"costUSD\":0.0947511,\"contextWindow\":200000,\"maxOutputTokens\":32000}},\"permission_denials\":[],\"terminal_reason\":\"completed\",\"fast_mode_state\":\"off\",\"origin\":{\"kind\":\"task-notification\"}}",
]

type Replay = {
  /** Items keyed by id, in the state the last line left them. */
  items: Map<string, AgentTurnItem>
  /** Everything the run would have appended to the answer bubble. */
  text: string
  /** Item ids in the order they first reached the transcript. */
  order: string[]
}

function replay(lines: string[], cwd?: string): Replay {
  const stream = new ClaudeActivityStream(cwd)
  const items = new Map<string, AgentTurnItem>()
  const order: string[] = []
  let text = ""
  for (const line of lines) {
    const ev = safeJson(line)
    if (!ev) continue
    const out = stream.push(ev)
    for (const item of out.items) {
      if (!items.has(item.id)) order.push(item.id)
      items.set(item.id, item)
    }
    text += out.text
  }
  return { items, text, order }
}

function only<K extends AgentTurnItem["kind"]>(
  replayed: Replay,
  kind: K,
): Extract<AgentTurnItem, { kind: K }> {
  const found = [...replayed.items.values()].filter((item) => item.kind === kind)
  expect(found).toHaveLength(1)
  return found[0] as Extract<AgentTurnItem, { kind: K }>
}

describe("Claude Code subagents", () => {
  it("gives the spawned agent one card of its own, not an opaque tool call", () => {
    const agent = only(replay(SUBAGENT), "subagent")
    expect(agent).toMatchObject({
      kind: "subagent",
      name: "Explore",
      status: "completed",
      description: "Read notes.txt and report first line",
    })
  })

  it("shows what the child ran, in order, each with its own outcome", () => {
    const agent = only(replay(SUBAGENT), "subagent")
    expect(agent.steps).toEqual([
      { label: "Glob", detail: "Finding notes.txt", status: "completed" },
      { label: "Read", detail: "Reading notes.txt", status: "completed" },
    ])
  })

  it("keeps the child's answer, its token count and how long it took", () => {
    const agent = only(replay(SUBAGENT), "subagent")
    expect(agent.result).toBe("alpha")
    expect(agent).toMatchObject({ tokens: 11570, toolUses: 2, durationMs: 8701 })
  })

  it("never lets the child's prose into the turn the user is reading", () => {
    // The child's last message is the word "alpha"; reading `assistant` lines
    // without checking `parent_tool_use_id` puts it in the parent's bubble.
    expect(replay(SUBAGENT).text).toBe("")
  })

  it("does not quote the launch metadata the CLI marks as internal", () => {
    const agent = only(replay(SUBAGENT), "subagent")
    expect(agent.result).not.toMatch(/agentId|Async agent launched/)
  })

  it("publishes the agent card before the child has done anything", () => {
    // Only the parent's own tool_use — the child has not been heard from yet.
    const opened = replay(SUBAGENT.slice(0, 1))
    expect(only(opened, "subagent")).toMatchObject({
      name: "Explore",
      status: "running",
    })
  })
})

describe("Claude Code thinking and tools", () => {
  it("collects a message's thinking deltas into one reasoning card", () => {
    const reasoning = only(replay(THINKING_AND_TOOLS), "reasoning")
    expect(reasoning.summary.startsWith("The user is asking me to:")).toBe(true)
    expect(reasoning.summary).toContain("Read tiny.png with the Read tool")
  })

  it("names a tool call the moment its block opens, before the arguments land", () => {
    const started = replay(THINKING_AND_TOOLS.slice(0, 4))
    expect(only(started, "command")).toMatchObject({
      kind: "command",
      status: "running",
      command: "Bash",
    })
  })

  it("carries a shell command's exit code, output and failure", () => {
    const command = only(replay(THINKING_AND_TOOLS, "/p"), "command")
    expect(command).toMatchObject({
      kind: "command",
      status: "failed",
      command: "ls /definitely-missing-dir",
      exitCode: 1,
      cwd: "/p",
    })
    expect(command.output).toContain("No such file or directory")
  })

  it("records the image the agent looked at without keeping its bytes", () => {
    const image = only(replay(THINKING_AND_TOOLS), "image")
    expect(image).toMatchObject({ kind: "image", status: "completed", path: "tiny.png" })
    expect(JSON.stringify(image)).not.toContain("iVBORw0KGgo")
  })

  it("turns a Write into a file change with a diff", () => {
    const change = only(replay(THINKING_AND_TOOLS), "file_change")
    expect(change.changes[0]).toMatchObject({ path: "out.txt", kind: "add" })
    expect(change.changes[0]?.diff).toContain("+ done")
  })

  it("numbers the turn's steps in the order the CLI ran them", () => {
    const { order } = replay(THINKING_AND_TOOLS)
    expect(order.filter((id) => !id.startsWith("claude-think"))).toEqual([
      "claude-bash-toolu_01Gi5VRpF8qCEUX6KcyL7pp5",
      "claude-read-toolu_01JGRP1L5M9BTKX3ZrJwFS8e",
      "claude-write-toolu_01EKXmkR26zZoCGyUY6gjLUm",
    ])
  })
})

describe("Claude Code edits", () => {
  it("prefers the CLI's own patch over one re-derived from disk", () => {
    const change = only(replay(EDIT), "file_change")
    expect(change.changes[0]?.diff).toBe(
      "@@ -1,3 +1,3 @@\n- alpha\n+ ALPHA\n  beta\n  gamma",
    )
    expect(change.status).toBe("completed")
  })

  it("reads a Read as a plain tool call with its result", () => {
    const items = [...replay(EDIT).items.values()]
    const read = items.find((item) => item.kind === "tool" && item.name === "Read")
    expect(read).toMatchObject({ kind: "tool", status: "completed" })
  })

  it("renders an empty structured patch as nothing rather than an empty diff", () => {
    expect(structuredPatchToDiff([])).toBeNull()
    expect(structuredPatchToDiff(undefined)).toBeNull()
  })
})

describe("Claude Code web search", () => {
  it("keeps the query the agent searched for", () => {
    const search = only(replay(WEB_SEARCH), "web_search")
    expect(search).toMatchObject({
      kind: "web_search",
      status: "completed",
      query: "node.js current LTS version",
    })
  })
})

describe("Claude Code compaction", () => {
  it("opens the card while the CLI is compacting and settles it at the boundary", () => {
    const compacting = replay(COMPACTION.slice(0, 1))
    expect(only(compacting, "compaction")).toMatchObject({ status: "running" })

    const done = only(replay(COMPACTION), "compaction")
    expect(done).toMatchObject({
      kind: "compaction",
      status: "completed",
      trigger: "manual",
      preTokens: 28885,
      postTokens: 2535,
    })
  })
})

describe("Claude Code turn totals", () => {
  it("adds up the token counts of every internal turn, keeping the running cost", () => {
    // Both envelopes are real: the async subagent closes one turn, the reply
    // that reads its answer closes another. `total_cost_usd` is already a total.
    const merged = TWO_RESULTS.map((line) => safeJson(line)).reduce<
      ReturnType<typeof mergeClaudeUsage>
    >((acc, ev) => (ev ? mergeClaudeUsage(acc, readUsage(ev)) : acc), null)
    expect(merged).toMatchObject({
      inputTokens: 28,
      outputTokens: 1354,
      costUsd: 0.0947511,
      contextWindow: 200000,
    })
  })
})

describe("persisted transcripts", () => {
  it("describes an item kind this build has never seen without throwing", () => {
    const future = { id: "x", kind: "hologram", status: "completed" } as unknown
    expect(() => describeItem(future as AgentTurnItem)).not.toThrow()
  })
})
