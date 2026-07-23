use serde_json::{json, Value};

use super::*;

fn room_fixture() -> Room {
    Room {
        room_id: "roomid".to_string(),
        deck: ["1", "2", "3", "5"].map(str::to_string).to_vec(),
        game_phase: GamePhase::Playing,
        users: vec![
            User {
                username: "user 1".to_string(),
                user_type: UserType::Participant,
                your_user: true,
                card_value: "13".to_string(),
            },
            User {
                username: "user 2".to_string(),
                user_type: UserType::Spectator,
                your_user: false,
                card_value: "5".to_string(),
            },
        ],
        average: "12".to_string(),
        log: vec![LogEntry {
            level: LogLevel::Chat,
            message: "Hello World".to_string(),
        }],
    }
}

fn payload_with_users(users: Value) -> String {
    json!({
        "roomId": "room / 東京",
        "deck": ["1", "8", "?", "☕"],
        "gamePhase": "PLAYING",
        "users": users,
        "average": "0",
        "log": []
    })
    .to_string()
}

fn wire_user(username: &str, user_type: &str, your_user: bool, card_value: &str) -> Value {
    json!({
        "username": username,
        "userType": user_type,
        "yourUser": your_user,
        "cardValue": card_value
    })
}

const PLAY_13: &str = r#"{"requestType":"PlayCard","cardValue":"13"}"#;
const PLAY_UNICODE: &str = r#"{"requestType":"PlayCard","cardValue":"☕/世界"}"#;
const RETRACT: &str = r#"{"requestType":"PlayCard","cardValue":null}"#;
const RENAME: &str = r#"{"requestType":"ChangeName","name":"Ålice 東京"}"#;
const CHAT: &str = r#"{"requestType":"ChatMessage","message":"hello \"world\"\n世界"}"#;
const REVEAL: &str = r#"{"requestType":"RevealCards"}"#;
const RESTART: &str = r#"{"requestType":"StartNewRound"}"#;

#[test]
fn wire_room_json_structure_is_preserved() {
    let room = room_fixture();
    let expected = json!({
        "roomId": "roomid",
        "deck": ["1", "2", "3", "5"],
        "gamePhase": "PLAYING",
        "users": [
            wire_user("user 1", "PARTICIPANT", true, "13"),
            wire_user("user 2", "SPECTATOR", false, "5")
        ],
        "average": "12",
        "log": [{ "level": "CHAT", "message": "Hello World" }]
    });

    assert_eq!(serde_json::to_value(room).unwrap(), expected);
}

#[test]
fn full_room_payload_decodes_as_authoritative_snapshot_in_wire_order() {
    let payload = json!({
        "roomId": "planning-room",
        "deck": ["1", "3", "?", "☕"],
        "gamePhase": "CARDS_REVEALED",
        "users": [
            wire_user("Alice", "PARTICIPANT", true, "13"),
            wire_user("Bøb", "PARTICIPANT", false, "☕"),
            wire_user("Observer", "SPECTATOR", false, "8")
        ],
        "average": "13",
        "log": [
            { "level": "CHAT", "message": "héllo 世界" },
            { "level": "INFO", "message": "revealed" },
            { "level": "ERROR", "message": "problem" }
        ]
    })
    .to_string();

    let snapshot = decode_room_snapshot(&payload).unwrap();

    assert_eq!(snapshot.room.name, "planning-room");
    assert_eq!(snapshot.room.deck, ["1", "3", "?", "☕"]);
    assert_eq!(snapshot.room.phase, AppGamePhase::Revealed);
    assert_eq!(
        snapshot
            .room
            .players
            .iter()
            .map(|player| player.name.as_str())
            .collect::<Vec<_>>(),
        ["Alice", "Bøb", "Observer"]
    );
    assert_eq!(
        snapshot.room.players[0].vote,
        Vote::Revealed(VoteData::Number(13))
    );
    assert_eq!(
        snapshot.room.players[1].vote,
        Vote::Revealed(VoteData::Special("☕".to_string()))
    );
    assert_eq!(snapshot.room.players[2].vote, Vote::Missing);
    assert_eq!(
        snapshot
            .log
            .iter()
            .map(|entry| (entry.server_index, entry.level, entry.message.as_str()))
            .collect::<Vec<_>>(),
        [
            (0, AppLogLevel::Chat, "héllo 世界"),
            (1, AppLogLevel::Info, "revealed"),
            (2, AppLogLevel::Error, "problem"),
        ]
    );
}

#[test]
fn vote_sentinels_and_unicode_special_votes_are_normalized() {
    let payload = payload_with_users(json!([
        wire_user("hidden", "PARTICIPANT", false, "✅"),
        wire_user("missing-cross", "PARTICIPANT", false, "❌"),
        wire_user("missing-empty", "PARTICIPANT", true, ""),
        wire_user("number", "PARTICIPANT", false, "8"),
        wire_user("special", "PARTICIPANT", false, "☕"),
        wire_user("spectator-hidden", "SPECTATOR", false, "✅")
    ]));

    let votes = decode_room_snapshot(&payload)
        .unwrap()
        .room
        .players
        .into_iter()
        .map(|player| player.vote)
        .collect::<Vec<_>>();

    assert_eq!(
        votes,
        [
            Vote::Hidden,
            Vote::Missing,
            Vote::Missing,
            Vote::Revealed(VoteData::Number(8)),
            Vote::Revealed(VoteData::Special("☕".to_string())),
            Vote::Hidden,
        ]
    );
}

#[test]
fn unknown_wire_enums_never_panic_and_unsafe_logs_are_skipped() {
    let payload = json!({
        "roomId": "unknown-test",
        "deck": ["1"],
        "gamePhase": "FUTURE_PHASE",
        "users": [wire_user("Future user", "FUTURE_ROLE", true, "5")],
        "average": "5",
        "log": [
            { "level": "INFO", "message": "before" },
            { "level": "FUTURE_LEVEL", "message": "skip" },
            { "level": "CHAT", "message": "after" }
        ]
    })
    .to_string();

    let snapshot = decode_room_snapshot(&payload).unwrap();

    assert_eq!(snapshot.room.phase, AppGamePhase::Unknown);
    assert_eq!(snapshot.room.players[0].user_type, AppUserType::Unknown);
    assert_eq!(
        snapshot.room.players[0].vote,
        Vote::Revealed(VoteData::Number(5))
    );
    assert_eq!(
        snapshot
            .log
            .iter()
            .map(|entry| (entry.server_index, entry.message.as_str()))
            .collect::<Vec<_>>(),
        [(0, "before"), (2, "after")]
    );
}

#[test]
fn malformed_room_payloads_are_rejected() {
    assert!(decode_room_snapshot("not json").is_err());
    assert!(decode_room_snapshot(r#"{"roomId":"missing-fields"}"#).is_err());
}

#[test]
fn every_command_keeps_its_exact_json_contract() {
    let commands = [
        (encode_vote("13"), PLAY_13),
        (encode_vote("☕/世界"), PLAY_UNICODE),
        (encode_retract_vote(), RETRACT),
        (encode_change_name("Ålice 東京"), RENAME),
        (encode_chat_message("hello \"world\"\n世界"), CHAT),
        (encode_reveal_cards(), REVEAL),
        (encode_start_new_round(), RESTART),
    ];
    for (command, expected) in commands {
        assert_eq!(command.unwrap(), expected);
    }
}

#[test]
fn room_urls_preserve_root_and_nested_base_paths_without_trailing_separators() {
    for (endpoint, name, role, expected) in [
        (
            "wss://example.test",
            "Alice",
            ConnectionRole::Participant,
            "wss://example.test/rooms/planning?user=Alice&userType=PARTICIPANT",
        ),
        (
            "ws://example.test/",
            "Alice",
            ConnectionRole::Participant,
            "ws://example.test/rooms/planning?user=Alice&userType=PARTICIPANT",
        ),
        (
            "wss://example.test/base/path///",
            "Observer",
            ConnectionRole::Spectator,
            "wss://example.test/base/path/rooms/planning?user=Observer&userType=SPECTATOR",
        ),
    ] {
        assert_eq!(
            build_room_url(endpoint, "planning", name, role).unwrap(),
            expected
        );
    }
}

#[test]
fn room_urls_encode_hostile_and_unicode_values_once() {
    let room = "% /?#&= %2F 東京☕";
    let name = "Ålice % /?#&= %2F 東京☕";
    let url = build_room_url(
        "wss://example.test/nested/base/",
        room,
        name,
        ConnectionRole::Spectator,
    )
    .unwrap();

    assert_eq!(
        url,
        "wss://example.test/nested/base/rooms/%25%20%2F%3F%23&=%20%252F%20%E6%9D%B1%E4%BA%AC%E2%98%95?user=%C3%85lice+%25+%2F%3F%23%26%3D+%252F+%E6%9D%B1%E4%BA%AC%E2%98%95&userType=SPECTATOR"
    );
}

#[test]
fn room_urls_reject_exact_dot_names_without_rejecting_other_dots() {
    for room in [".", ".."] {
        let error =
            build_room_url("not a URL", room, "Alice", ConnectionRole::Participant).unwrap_err();

        assert_eq!(error, RoomUrlError::InvalidRoom);
        assert_eq!(error.field(), "room");
        assert_eq!(error.to_string(), "Room must not be `.` or `..`.");
    }

    for room in [".planning", "planning.", "..."] {
        let url = build_room_url(
            "wss://example.test/nested/base/",
            room,
            "Alice",
            ConnectionRole::Participant,
        )
        .unwrap();

        assert!(url.contains(&format!("/rooms/{room}?user=Alice&")));
    }
}

#[test]
fn room_urls_reject_non_base_endpoint_components() {
    assert!(matches!(
        build_room_url("not a URL", "room", "user", ConnectionRole::Participant),
        Err(RoomUrlError::InvalidUrl(_))
    ));
    for (endpoint, expected) in [
        ("https://example.test", RoomUrlError::UnsupportedScheme),
        (
            "wss://user:password@example.test/base",
            RoomUrlError::CredentialsNotAllowed,
        ),
        (
            "wss://example.test/base?existing=value",
            RoomUrlError::QueryNotAllowed,
        ),
        (
            "wss://example.test/base#fragment",
            RoomUrlError::FragmentNotAllowed,
        ),
    ] {
        assert_eq!(
            build_room_url(endpoint, "room", "user", ConnectionRole::Participant),
            Err(expected)
        );
    }
}

#[test]
fn room_url_errors_have_stable_messages_and_sources() {
    let parse_error =
        build_room_url("not a URL", "room", "user", ConnectionRole::Participant).unwrap_err();
    assert!(parse_error
        .to_string()
        .starts_with("invalid WebSocket URL:"));
    assert_eq!(parse_error.field(), "endpoint");
    assert!(parse_error.source().is_some());

    for error in [
        RoomUrlError::InvalidRoom,
        RoomUrlError::UnsupportedScheme,
        RoomUrlError::CredentialsNotAllowed,
        RoomUrlError::QueryNotAllowed,
        RoomUrlError::FragmentNotAllowed,
        RoomUrlError::InvalidBaseUrl,
    ] {
        assert!(!error.to_string().is_empty());
        assert!(error.source().is_none());
    }
}
