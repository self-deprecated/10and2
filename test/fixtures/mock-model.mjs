#!/usr/bin/env node
// A deterministic stand-in for an OpenAI-compatible model API, so real coding-agent CLIs (Codex, OpenCode, Pi) can run in
// tests without a model: `node mock-model.mjs [port]` prints the port it listens on. It never calls anything.
//
// It answers the APIs those CLIs use (and Claude Code's, via ANTHROPIC_BASE_URL), streaming or not:
//   POST /v1/chat/completions   (and /chat/completions)
//   POST /v1/responses          (and /responses)
//   POST /v1/messages           Anthropic's Messages API (and /v1/messages/count_tokens)
//   GET  /v1/models
// The reply is decided by the newest user text:
//   contains SLOW<n>   streams the reply over n seconds (a turn that's busy long enough to steer)
//   contains ASKQ      (Messages API, with an AskUserQuestion tool offered) calls AskUserQuestion with one question,
//                      "Which one?", options Alpha and Beta; the tool's result then comes back as "ACK RESULT <it>".
//                      (Responses API, with Codex's request_user_input tool offered) calls request_user_input with the
//                      same question (id "pick"); a function_call_output then comes back as "ACK RESULT <it>"
//   contains OCASKQ    (Chat Completions, with OpenCode's question tool offered) calls question with the same question,
//                      options Alpha and Beta; the tool's result (a "tool" message) then comes back as "ACK RESULT <it>"
//   otherwise          answers at once
// and is always "ACK <the user's text>", so a test can see exactly what reached the model. Every request is appended
// to $MOCK_MODEL_LOG (JSON lines: path, the user texts it saw), when set.
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";

const port = Number(process.argv[2] ?? 0);
const log = process.env.MOCK_MODEL_LOG;

/** Every user-authored text in a request body, oldest first, whichever API shape it uses. */
function userTexts(body) {
  const out = [];
  const text = (c) => typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => p?.text ?? p?.content ?? "").filter((t) => typeof t === "string").join("\n") : "";
  for (const m of body.messages ?? []) if (m?.role === "user") out.push(text(m.content));
  // Anthropic's system-reminder blocks ride along in user content; only the user's own words count.
  if (Array.isArray(body.messages)) for (let i = 0; i < out.length; i++) out[i] = out[i].replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
  const input = body.input;
  if (typeof input === "string") out.push(input);
  else if (Array.isArray(input)) for (const m of input) if (m?.role === "user" || m?.type === "message" && m?.role === "user") out.push(text(m.content));
  return out.filter((t) => t.trim());
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const path = new URL(req.url, "http://x").pathname.replace(/^\/v1/, "");
  if (req.method === "GET" && path === "/models") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ object: "list", data: [{ id: "mock-model", object: "model", owned_by: "mock" }] }));
  }
  let body = {};
  try { body = JSON.parse(raw || "{}"); } catch { /* an empty or odd body still gets an answer */ }
  const texts = userTexts(body);
  // A harness's own housekeeping requests (titles, summaries) also arrive here; they're answered the same way.
  const last = texts.at(-1) ?? "";
  if (log) appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), path, stream: !!body.stream, texts }) + "\n");
  const reply = `ACK ${last.replace(/\s+/g, " ").trim().slice(0, 400)}`;
  const seconds = Number(/SLOW(\d+)/.exec(last)?.[1] ?? 0);
  const words = reply.split(/(?<= )/);
  const gap = seconds ? (seconds * 1000) / Math.max(1, words.length) : 0;
  const id = `mock-${Date.now().toString(36)}`, created = Math.floor(Date.now() / 1000), model = body.model ?? "mock-model";

  if (path === "/chat/completions") {
    // A tool's result as the newest message: echo it. The OCASKQ prompt, with OpenCode's question tool offered (its own
    // title requests offer no tools): ask one question with it.
    const lastMsg = (body.messages ?? []).at(-1);
    if (lastMsg?.role === "tool") {
      const said = typeof lastMsg.content === "string" ? lastMsg.content : (lastMsg.content ?? []).map((p) => p?.text ?? "").join(" ");
      words.splice(0, words.length, ...`ACK RESULT ${said.replace(/\s+/g, " ").trim().slice(0, 400)}`.split(/(?<= )/));
    } else if (/OCASKQ/.test(last) && (body.tools ?? []).some((t) => t?.function?.name === "question")) {
      const args = JSON.stringify({ questions: [{ question: "Which one?", header: "Pick", options: [{ label: "Alpha", description: "the first" }, { label: "Beta", description: "the second" }] }] });
      const call = { index: 0, id: `call_${id}`, type: "function", function: { name: "question", arguments: args } };
      const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
      if (!body.stream) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ id, object: "chat.completion", created, model, choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: call.id, type: "function", function: call.function }] }, finish_reason: "tool_calls" }], usage }));
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      send({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ ...call, function: { name: "question", arguments: "" } }] }, finish_reason: null }] });
      send({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args } }] }, finish_reason: null }] });
      send({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage });
      res.write("data: [DONE]\n\n");
      return res.end();
    }
    const reply = words.join("");
    if (!body.stream) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ id, object: "chat.completion", created, model, choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: words.length, total_tokens: 1 + words.length } }));
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    send({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
    for (const w of words) { send({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { content: w }, finish_reason: null }] }); if (gap) await sleep(gap); }
    send({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: words.length, total_tokens: 1 + words.length } });
    res.write("data: [DONE]\n\n");
    return res.end();
  }

  if (path === "/messages/count_tokens") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ input_tokens: 1 }));
  }
  if (path === "/messages") {
    // A tool's result as the newest turn: echo it. The ASKQ prompt: ask a question with Claude Code's own tool.
    const lastMsg = (body.messages ?? []).at(-1);
    const result = Array.isArray(lastMsg?.content) ? lastMsg.content.find((b) => b?.type === "tool_result") : null;
    const asking = !result && /ASKQ/.test(last) && (body.tools ?? []).some((t) => t?.name === "AskUserQuestion");
    if (result) {
      const said = typeof result.content === "string" ? result.content : (result.content ?? []).map((b) => b?.text ?? "").join(" ");
      words.splice(0, words.length, ...`ACK RESULT ${said.replace(/\s+/g, " ").trim().slice(0, 400)}`.split(/(?<= )/));
    }
    if (asking) {
      const input = { questions: [{ question: "Which one?", header: "Pick", multiSelect: false, options: [{ label: "Alpha", description: "the first" }, { label: "Beta", description: "the second" }] }] };
      const toolMsg = { id: `msg_${id}`, type: "message", role: "assistant", model, content: [{ type: "tool_use", id: `toolu_${id}`, name: "AskUserQuestion", input }], stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } };
      if (!body.stream) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(toolMsg)); }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const send = (type, o) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`);
      send("message_start", { message: { ...toolMsg, content: [], stop_reason: null } });
      send("content_block_start", { index: 0, content_block: { type: "tool_use", id: `toolu_${id}`, name: "AskUserQuestion", input: {} } });
      send("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } });
      send("content_block_stop", { index: 0 });
      send("message_delta", { delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 1 } });
      send("message_stop", {});
      return res.end();
    }
    const reply = words.join("");
    const message = (content, stop) => ({ id: `msg_${id}`, type: "message", role: "assistant", model, content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 1, output_tokens: words.length, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } });
    if (!body.stream) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(message([{ type: "text", text: reply }], "end_turn")));
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const send = (type, o) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`);
    send("message_start", { message: message([], null) });
    send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    for (const w of words) { send("content_block_delta", { index: 0, delta: { type: "text_delta", text: w } }); if (gap) await sleep(gap); }
    send("content_block_stop", { index: 0 });
    send("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: words.length } });
    send("message_stop", {});
    return res.end();
  }

  if (path === "/responses") {
    const msgId = `msg_${id}`;
    // A tool's result as the newest input: echo it. The ASKQ prompt, with Codex's request_user_input tool offered (its
    // own title requests offer no tools): ask one question with it.
    const lastInput = Array.isArray(body.input) ? body.input.at(-1) : null;
    if (lastInput?.type === "function_call_output") {
      const said = typeof lastInput.output === "string" ? lastInput.output : JSON.stringify(lastInput.output ?? "");
      words.splice(0, words.length, ...`ACK RESULT ${said.replace(/\s+/g, " ").trim().slice(0, 400)}`.split(/(?<= )/));
    } else if (/ASKQ/.test(last) && (body.tools ?? []).some((t) => t?.name === "request_user_input")) {
      const args = JSON.stringify({ questions: [{ id: "pick", header: "Pick", question: "Which one?", options: [{ label: "Alpha", description: "the first" }, { label: "Beta", description: "the second" }] }] });
      const call = { id: `fc_${id}`, type: "function_call", status: "completed", name: "request_user_input", arguments: args, call_id: `call_${id}` };
      const done = { id: `resp_${id}`, object: "response", created_at: created, status: "completed", model, output: [call], usage: { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 } };
      if (!body.stream) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(done)); }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      let seq = 0;
      const send = (type, o) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...o })}\n\n`);
      send("response.created", { response: { ...done, status: "in_progress", output: [] } });
      send("response.output_item.added", { output_index: 0, item: { ...call, status: "in_progress", arguments: "" } });
      send("response.function_call_arguments.delta", { item_id: call.id, output_index: 0, delta: args });
      send("response.function_call_arguments.done", { item_id: call.id, output_index: 0, arguments: args });
      send("response.output_item.done", { output_index: 0, item: call });
      send("response.completed", { response: done });
      return res.end();
    }
    const reply = words.join("");
    const item = (text) => ({ id: msgId, type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] });
    const response = (status, output) => ({ id: `resp_${id}`, object: "response", created_at: created, status, model, output, usage: { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: words.length, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 1 + words.length } });
    if (!body.stream) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(response("completed", [item(reply)])));
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    let seq = 0;
    const send = (type, o) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...o })}\n\n`);
    send("response.created", { response: response("in_progress", []) });
    send("response.in_progress", { response: response("in_progress", []) });
    send("response.output_item.added", { output_index: 0, item: { id: msgId, type: "message", status: "in_progress", role: "assistant", content: [] } });
    send("response.content_part.added", { item_id: msgId, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
    for (const w of words) { send("response.output_text.delta", { item_id: msgId, output_index: 0, content_index: 0, delta: w }); if (gap) await sleep(gap); }
    send("response.output_text.done", { item_id: msgId, output_index: 0, content_index: 0, text: reply });
    send("response.content_part.done", { item_id: msgId, output_index: 0, content_index: 0, part: { type: "output_text", text: reply, annotations: [] } });
    send("response.output_item.done", { output_index: 0, item: item(reply) });
    send("response.completed", { response: response("completed", [item(reply)]) });
    return res.end();
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: `mock-model has no ${req.method} ${path}` } }));
}).listen(port, "0.0.0.0", function () { console.log(this.address().port); });
