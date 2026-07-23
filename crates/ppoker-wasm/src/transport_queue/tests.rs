use super::*;

#[test]
fn event_budget_retains_prior_events_then_exactly_one_error() {
    let mut queue = EventQueue::default();
    assert!(!queue.is_stopped());
    assert!((0..MAX_QUEUED_EVENTS)
        .all(|length| { queue.push(TransportEvent::Binary { length }) == PushResult::Queued }));
    assert_eq!(
        queue.push(TransportEvent::Binary { length: usize::MAX }),
        PushResult::Overflowed
    );
    assert!(queue.is_stopped());
    assert_eq!(
        queue.push(TransportEvent::Error("late".to_string())),
        PushResult::Stopped
    );
    assert!(
        (0..MAX_QUEUED_EVENTS).all(|length| queue.pop() == Some(TransportEvent::Binary { length }))
    );
    assert_eq!(
        queue.pop(),
        Some(TransportEvent::Error(QUEUE_OVERFLOW_ERROR.to_string()))
    );
    assert_eq!(queue.pop(), None);
    queue.clear();
    assert!(queue.is_stopped());
}

#[test]
fn text_budget_is_exact_and_decrements_as_messages_are_consumed() {
    let mut queue = EventQueue::default();
    for text in ["abc".to_string(), "x".repeat(MAX_QUEUED_TEXT_BYTES - 3)] {
        assert_eq!(queue.push(TransportEvent::Text(text)), PushResult::Queued);
    }
    assert_eq!(
        queue.push(TransportEvent::Text("overflow".to_string())),
        PushResult::Overflowed
    );
    for (text, remaining) in [
        ("abc".to_string(), MAX_QUEUED_TEXT_BYTES - 3),
        ("x".repeat(MAX_QUEUED_TEXT_BYTES - 3), 0),
    ] {
        assert_eq!(queue.pop(), Some(TransportEvent::Text(text)));
        assert_eq!(queue.queued_text_bytes, remaining);
    }
    assert_eq!(
        queue.pop(),
        Some(TransportEvent::Error(QUEUE_OVERFLOW_ERROR.to_string()))
    );
    assert_eq!(queue.pop(), None);
}

#[test]
fn oversized_first_text_stops_without_retaining_payload_or_late_events() {
    let mut queue = EventQueue::default();
    assert_eq!(
        queue.push(TransportEvent::Text("x".repeat(MAX_QUEUED_TEXT_BYTES + 1))),
        PushResult::Overflowed
    );
    assert_eq!(queue.queued_text_bytes, 0);
    assert_eq!(queue.push(TransportEvent::Opened), PushResult::Stopped);
    assert_eq!(
        queue.pop(),
        Some(TransportEvent::Error(QUEUE_OVERFLOW_ERROR.to_string()))
    );
    assert_eq!(queue.pop(), None);
}

#[test]
fn terminal_events_stop_late_callback_growth() {
    for terminal in [
        TransportEvent::Closed,
        TransportEvent::Error("failed".to_string()),
    ] {
        let mut queue = EventQueue::default();
        assert_eq!(queue.push(terminal), PushResult::Queued);
        assert_eq!(queue.overflow(), PushResult::Stopped);
        assert_eq!(
            queue.push(TransportEvent::Text("late".to_string())),
            PushResult::Stopped
        );
        assert!(queue.pop().is_some());
        assert_eq!(queue.pop(), None);
    }
}
