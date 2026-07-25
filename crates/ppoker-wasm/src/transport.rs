use std::cell::Cell;
use std::rc::Rc;

use js_sys::{ArrayBuffer, JsString, Uint8Array};
use ppoker_core::client::{Transport, TransportEvent};
use wasm_bindgen::closure::Closure;
use wasm_bindgen::{JsCast, JsValue};
use web_sys::{BinaryType, Event, MessageEvent, WebSocket};

use crate::EventSink;

pub(crate) const MAX_TEXT_MESSAGE_BYTES: usize = 1024 * 1024;
pub(crate) const MESSAGE_TOO_LARGE_ERROR: &str =
    "Browser WebSocket text message exceeds 1048576 bytes.";

struct BrowserCallbacks {
    _on_open: Closure<dyn FnMut(Event)>,
    _on_message: Closure<dyn FnMut(MessageEvent)>,
    _on_error: Closure<dyn FnMut(Event)>,
    _on_close: Closure<dyn FnMut(Event)>,
}

pub(crate) struct BrowserTransport {
    socket: Option<WebSocket>,
    active: Rc<Cell<bool>>,
    close_started: Cell<bool>,
    callbacks: Option<BrowserCallbacks>,
    closed: bool,
}

impl BrowserTransport {
    pub(crate) fn connect(url: &str, events: EventSink) -> Result<Self, String> {
        let socket = WebSocket::new(url).map_err(js_error_message)?;
        socket.set_binary_type(BinaryType::Arraybuffer);

        let active = Rc::new(Cell::new(true));

        let open_active = active.clone();
        let open_events = events.clone();
        let on_open = Closure::new(move |_event: Event| {
            if open_active.get() {
                open_events(TransportEvent::Opened);
            }
        });

        let message_active = active.clone();
        let message_events = events.clone();
        let on_message = Closure::new(move |event: MessageEvent| {
            if !message_active.get() {
                return;
            }

            let data = event.data();
            if data.is_string() {
                let text = JsString::from(data.clone());
                if text.length() as usize > MAX_TEXT_MESSAGE_BYTES {
                    message_events(TransportEvent::Error(MESSAGE_TOO_LARGE_ERROR.to_string()));
                    return;
                }
                let text = data
                    .as_string()
                    .expect("string values convert to Rust strings");
                if text.len() > MAX_TEXT_MESSAGE_BYTES {
                    message_events(TransportEvent::Error(MESSAGE_TOO_LARGE_ERROR.to_string()));
                } else {
                    message_events(TransportEvent::Text(text));
                }
            } else if data.is_instance_of::<ArrayBuffer>() {
                message_events(TransportEvent::Binary {
                    length: Uint8Array::new(&data).length() as usize,
                });
            } else {
                message_events(TransportEvent::Binary { length: 0 });
            }
        });

        let error_active = active.clone();
        let error_events = events.clone();
        let on_error = Closure::new(move |_event: Event| {
            if error_active.get() {
                error_events(TransportEvent::Error(
                    "WebSocket transport error.".to_string(),
                ));
            }
        });

        let close_active = active.clone();
        let on_close = Closure::new(move |_event: Event| {
            if close_active.get() {
                events(TransportEvent::Closed);
            }
        });

        socket.set_onopen(Some(on_open.as_ref().unchecked_ref()));
        socket.set_onmessage(Some(on_message.as_ref().unchecked_ref()));
        socket.set_onerror(Some(on_error.as_ref().unchecked_ref()));
        socket.set_onclose(Some(on_close.as_ref().unchecked_ref()));

        Ok(Self {
            socket: Some(socket),
            active,
            close_started: Cell::new(false),
            callbacks: Some(BrowserCallbacks {
                _on_open: on_open,
                _on_message: on_message,
                _on_error: on_error,
                _on_close: on_close,
            }),
            closed: false,
        })
    }

    fn cleanup(&mut self) {
        if self.closed {
            return;
        }
        self.closed = true;
        self.active.set(false);

        if let Some(socket) = self.socket.take() {
            socket.set_onopen(None);
            socket.set_onmessage(None);
            socket.set_onerror(None);
            socket.set_onclose(None);
            if !self.close_started.replace(true) {
                let _ = socket.close();
            }
        }

        if let Some(callbacks) = self.callbacks.take() {
            defer_drop(callbacks);
        }
    }
}

impl Transport for BrowserTransport {
    fn poll_event(&mut self) -> Option<TransportEvent> {
        None
    }

    fn send_text(&mut self, message: String) -> Result<(), String> {
        if self.closed || !self.active.get() {
            return Err("WebSocket transport is closed.".to_string());
        }
        let socket = self
            .socket
            .as_ref()
            .ok_or_else(|| "WebSocket transport is closed.".to_string())?;
        if socket.ready_state() != WebSocket::OPEN {
            return Err("WebSocket connection is not open.".to_string());
        }
        socket.send_with_str(&message).map_err(js_error_message)
    }

    fn close(&mut self) {
        self.cleanup();
    }
}

impl Drop for BrowserTransport {
    fn drop(&mut self) {
        self.cleanup();
    }
}

fn defer_drop(callbacks: BrowserCallbacks) {
    let callback = Closure::once_into_js(move || {
        drop(callbacks);
    });
    web_sys::window()
        .expect("browser transports require a window")
        .queue_microtask(callback.unchecked_ref());
}

fn js_error_message(value: JsValue) -> String {
    value
        .as_string()
        .or_else(|| js_sys::Error::from(value).message().as_string())
        .filter(|message| !message.is_empty())
        .unwrap_or_else(|| "Browser WebSocket operation failed.".to_string())
}
