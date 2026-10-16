// Test-only SSE fixture for loopback providers; never contacts a real model provider.
export function sendProviderResponse(res, { api, toolCalls = [], text = "done" }) {
  if (!["openai-completions", "openai-responses", "anthropic-messages"].includes(api))
    throw new Error(`Unverified API refused: ${api}`);
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (type, data) =>
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  if (api === "openai-completions") {
    const base = {
      id: "chatcmpl-stub",
      object: "chat.completion.chunk",
      created: 1,
      model: "dummy-model",
    };
    const event = (delta, finish_reason = null) =>
      res.write(
        `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      );
    event({ role: "assistant" });
    if (toolCalls.length) {
      event({
        tool_calls: toolCalls.map(({ id, name, arguments: args }, index) => ({
          index,
          id,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        })),
      });
      event({}, "tool_calls");
    } else {
      event({ content: text });
      event({}, "stop");
    }
    res.end("data: [DONE]\n\n");
  } else if (api === "openai-responses") {
    const response = {
      id: "resp_stub",
      status: "in_progress",
      model: "dummy-model",
      output: [],
    };
    send("response.created", { response });
    const items = toolCalls.length
      ? toolCalls.map(({ id, name, arguments: args }, index) => ({
          type: "function_call",
          id: `fc_${index}`,
          call_id: id,
          name,
          arguments: JSON.stringify(args),
          status: "completed",
        }))
      : [
          {
            type: "message",
            id: "msg_stub",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text, annotations: [] }],
          },
        ];
    for (const [output_index, item] of items.entries()) {
      send("response.output_item.added", {
        output_index,
        item: { ...item, arguments: "", content: [] },
      });
      if (item.type === "function_call")
        send("response.function_call_arguments.delta", {
          output_index,
          item_id: item.id,
          delta: item.arguments,
        });
      else
        send("response.output_text.delta", {
          output_index,
          item_id: item.id,
          content_index: 0,
          delta: text,
        });
      send("response.output_item.done", { output_index, item });
    }
    send("response.completed", {
      response: {
        ...response,
        status: "completed",
        output: items,
        usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
      },
    });
    res.end();
  } else {
    send("message_start", {
      message: {
        id: "msg_stub",
        type: "message",
        role: "assistant",
        model: "dummy-model",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    });
    if (toolCalls.length) {
      for (const [index, { id, name, arguments: args }] of toolCalls.entries()) {
        send("content_block_start", {
          index,
          content_block: { type: "tool_use", id, name, input: {} },
        });
        send("content_block_delta", {
          index,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(args) },
        });
        send("content_block_stop", { index });
      }
    } else {
      send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      send("content_block_delta", { index: 0, delta: { type: "text_delta", text } });
      send("content_block_stop", { index: 0 });
    }
    send("message_delta", {
      delta: {
        stop_reason: toolCalls.length ? "tool_use" : "end_turn",
        stop_sequence: null,
      },
      usage: { output_tokens: 1 },
    });
    send("message_stop", {});
    res.end();
  }
}
