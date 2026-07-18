use std::cell::{Cell, RefCell};
use std::rc::Rc;

use js_sys::{ArrayBuffer, JsString, Uint8Array};
use ppoker_core::client::{Transport, TransportEvent};
use wasm_bindgen::closure::Closure;
use wasm_bindgen::{JsCast, JsValue};
use web_sys::{BinaryType, Event, MessageEvent, WebSocket};

use crate::transport_queue::{EventQueue, PushResult, MAX_QUEUED_TEXT_BYTES};

pub(crate) struct BrowserTransport {
    socket: Option<WebSocket>,
    events: Rc<RefCell<EventQueue>>,
    close_started: Rc<Cell<bool>>,
    on_open: Option<Closure<dyn FnMut(Event)>>,
    on_message: Option<Closure<dyn FnMut(MessageEvent)>>,
    on_error: Option<Closure<dyn FnMut(Event)>>,
    on_close: Option<Closure<dyn FnMut(Event)>>,
    closed: bool,
}

impl BrowserTransport {
    pub(crate) fn connect(url: &str) -> Result<Self, String> {
        let socket = WebSocket::new(url).map_err(js_error_message)?;
        socket.set_binary_type(BinaryType::Arraybuffer);

        let events = Rc::new(RefCell::new(EventQueue::default()));
        let close_started = Rc::new(Cell::new(false));
        let open_events = events.clone();
        let open_socket = socket.clone();
        let open_close_started = close_started.clone();
        let on_open = Closure::new(move |_event: Event| {
            queue_event(
                &open_events,
                TransportEvent::Opened,
                &open_socket,
                &open_close_started,
            );
        });

        let message_events = events.clone();
        let message_socket = socket.clone();
        let message_close_started = close_started.clone();
        let on_message = Closure::new(move |event: MessageEvent| {
            if message_events.borrow().is_stopped() {
                return;
            }
            let data = event.data();
            let result = if data.is_string() {
                let text = JsString::from(data.clone());
                if text.length() as usize > MAX_QUEUED_TEXT_BYTES {
                    message_events.borrow_mut().overflow()
                } else {
                    message_events.borrow_mut().push(TransportEvent::Text(
                        data.as_string()
                            .expect("string values convert to Rust strings"),
                    ))
                }
            } else if data.is_instance_of::<ArrayBuffer>() {
                message_events.borrow_mut().push(TransportEvent::Binary {
                    length: Uint8Array::new(&data).length() as usize,
                })
            } else {
                message_events
                    .borrow_mut()
                    .push(TransportEvent::Binary { length: 0 })
            };
            close_on_overflow(result, &message_socket, &message_close_started);
        });

        let error_events = events.clone();
        let error_socket = socket.clone();
        let error_close_started = close_started.clone();
        let on_error = Closure::new(move |_event: Event| {
            queue_event(
                &error_events,
                TransportEvent::Error("WebSocket transport error.".to_string()),
                &error_socket,
                &error_close_started,
            );
        });

        let close_events = events.clone();
        let close_socket = socket.clone();
        let close_close_started = close_started.clone();
        let on_close = Closure::new(move |_event: Event| {
            queue_event(
                &close_events,
                TransportEvent::Closed,
                &close_socket,
                &close_close_started,
            );
        });

        socket.set_onopen(Some(on_open.as_ref().unchecked_ref()));
        socket.set_onmessage(Some(on_message.as_ref().unchecked_ref()));
        socket.set_onerror(Some(on_error.as_ref().unchecked_ref()));
        socket.set_onclose(Some(on_close.as_ref().unchecked_ref()));

        Ok(Self {
            socket: Some(socket),
            events,
            close_started,
            on_open: Some(on_open),
            on_message: Some(on_message),
            on_error: Some(on_error),
            on_close: Some(on_close),
            closed: false,
        })
    }

    fn cleanup(&mut self) {
        if self.closed {
            return;
        }
        self.closed = true;

        if let Some(socket) = self.socket.as_ref() {
            socket.set_onopen(None);
            socket.set_onmessage(None);
            socket.set_onerror(None);
            socket.set_onclose(None);
            close_socket_once(socket, &self.close_started);
        }

        self.on_open.take();
        self.on_message.take();
        self.on_error.take();
        self.on_close.take();
        self.socket.take();
        self.events.borrow_mut().clear();
    }
}

impl Transport for BrowserTransport {
    fn poll_event(&mut self) -> Option<TransportEvent> {
        self.events.borrow_mut().pop()
    }

    fn send_text(&mut self, message: String) -> Result<(), String> {
        self.socket
            .as_ref()
            .ok_or_else(|| "WebSocket transport is closed.".to_string())?
            .send_with_str(&message)
            .map_err(js_error_message)
    }

    fn close(&mut self) {
        self.cleanup();
    }
}

fn queue_event(
    events: &Rc<RefCell<EventQueue>>,
    event: TransportEvent,
    socket: &WebSocket,
    close_started: &Cell<bool>,
) {
    let result = events.borrow_mut().push(event);
    close_on_overflow(result, socket, close_started);
}

fn close_on_overflow(result: PushResult, socket: &WebSocket, close_started: &Cell<bool>) {
    if result == PushResult::Overflowed {
        close_socket_once(socket, close_started);
    }
}

fn close_socket_once(socket: &WebSocket, close_started: &Cell<bool>) {
    if !close_started.replace(true) {
        let _ = socket.close();
    }
}

impl Drop for BrowserTransport {
    fn drop(&mut self) {
        self.cleanup();
    }
}

fn js_error_message(value: JsValue) -> String {
    value
        .as_string()
        .or_else(|| js_sys::Error::from(value).message().as_string())
        .filter(|message| !message.is_empty())
        .unwrap_or_else(|| "Browser WebSocket operation failed.".to_string())
}
