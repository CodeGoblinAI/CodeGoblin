//! OpenAI-compatible HTTP surface for the CodeGoblin first-party local runtime.
//!
//! Exposes the minimum the existing `codegoblin` provider needs (it points at
//! `http://127.0.0.1:8787/v1`): `GET /v1/models`, `POST /v1/chat/completions`
//! (streaming + non-streaming), and `GET /health`. Generation is delegated to
//! [`crate::inference`], which is a stub until built with `--features inference`.

use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tiny_http::{Header, Method, Request, Response, Server};

use crate::inference::{self, GenerateParams, Message};

pub fn run(addr: &str, model: &str) -> Result<(), String> {
    let server = Server::http(addr).map_err(|err| err.to_string())?;
    eprintln!(
        "codegoblin-native serve: OpenAI-compatible API on http://{addr}/v1 (model: {model}, backend: {})",
        inference::backend_label()
    );
    for request in server.incoming_requests() {
        if let Err(err) = route(request, model) {
            eprintln!("codegoblin-native serve: request error: {err}");
        }
    }
    Ok(())
}

fn route(mut request: Request, model: &str) -> std::io::Result<()> {
    let method = request.method().clone();
    let url = request.url().to_string();
    let path = url.split('?').next().unwrap_or(&url);

    match (&method, path) {
        (Method::Get, "/health") => {
            respond_json(request, 200, json!({ "ok": true, "backend": inference::backend_label() }))
        }
        (Method::Get, "/v1/models") => respond_json(
            request,
            200,
            json!({
                "object": "list",
                "data": [{ "id": model, "object": "model", "owned_by": "codegoblin" }],
            }),
        ),
        (Method::Post, "/v1/chat/completions") => {
            let mut body = String::new();
            request.as_reader().read_to_string(&mut body)?;
            handle_chat(request, model, &body)
        }
        _ => respond_json(request, 404, json!({ "error": { "message": "not found" } })),
    }
}

fn handle_chat(request: Request, model: &str, body: &str) -> std::io::Result<()> {
    let parsed: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let messages = parse_messages(&parsed);
    let max_tokens = parsed.get("max_tokens").and_then(Value::as_u64).unwrap_or(512) as usize;
    let stream = parsed.get("stream").and_then(Value::as_bool).unwrap_or(false);

    let content = inference::generate(&GenerateParams { model: model.to_string(), messages, max_tokens });
    let id = format!("chatcmpl-{}", now_millis());
    let created = now_secs();

    if stream {
        respond_sse(request, &id, created, model, &content)
    } else {
        respond_json(request, 200, chat_completion(&id, created, model, &content))
    }
}

fn parse_messages(parsed: &Value) -> Vec<Message> {
    parsed
        .get("messages")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let role = item.get("role")?.as_str()?.to_string();
                    let content = item.get("content").and_then(Value::as_str).unwrap_or("").to_string();
                    Some(Message { role, content })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn chat_completion(id: &str, created: u64, model: &str, content: &str) -> Value {
    json!({
        "id": id,
        "object": "chat.completion",
        "created": created,
        "model": model,
        "choices": [{
            "index": 0,
            "message": { "role": "assistant", "content": content },
            "finish_reason": "stop",
        }],
        "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 },
    })
}

fn respond_json(request: Request, status: u16, body: Value) -> std::io::Result<()> {
    let response = Response::from_string(body.to_string())
        .with_status_code(status)
        .with_header(content_type("application/json"));
    request.respond(response)
}

fn respond_sse(request: Request, id: &str, created: u64, model: &str, content: &str) -> std::io::Result<()> {
    let delta = json!({
        "id": id, "object": "chat.completion.chunk", "created": created, "model": model,
        "choices": [{ "index": 0, "delta": { "role": "assistant", "content": content }, "finish_reason": Value::Null }],
    });
    let stop = json!({
        "id": id, "object": "chat.completion.chunk", "created": created, "model": model,
        "choices": [{ "index": 0, "delta": {}, "finish_reason": "stop" }],
    });
    let body = format!("data: {delta}\n\ndata: {stop}\n\ndata: [DONE]\n\n");
    let response = Response::from_string(body).with_header(content_type("text/event-stream"));
    request.respond(response)
}

fn content_type(value: &str) -> Header {
    Header::from_bytes(&b"Content-Type"[..], value.as_bytes()).expect("valid header")
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn now_millis() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_chat_messages() {
        let parsed: Value = serde_json::from_str(
            r#"{"messages":[{"role":"user","content":"hi"},{"role":"assistant","content":"yo"}]}"#,
        )
        .unwrap();
        let messages = parse_messages(&parsed);
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[1].content, "yo");
    }

    #[test]
    fn builds_openai_chat_completion_shape() {
        let value = chat_completion("chatcmpl-1", 100, "codegoblin-local", "hello");
        assert_eq!(value["object"], "chat.completion");
        assert_eq!(value["choices"][0]["message"]["role"], "assistant");
        assert_eq!(value["choices"][0]["message"]["content"], "hello");
        assert_eq!(value["choices"][0]["finish_reason"], "stop");
    }
}
