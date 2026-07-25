use super::*;

fn player(name: &str, vote: Vote) -> Player {
    Player {
        name: name.to_string(),
        vote,
        is_you: false,
        user_type: UserType::Player,
    }
}

#[test]
fn test_player_ordering() {
    let players = vec![
        player("Alice", Vote::Revealed(VoteData::Number(3))),
        player("Bob", Vote::Hidden),
        player("Charlie", Vote::Revealed(VoteData::Number(1))),
        player("David", Vote::Missing),
        player("Eve", Vote::Revealed(VoteData::Special("?".to_string()))),
    ];

    let mut sorted = players.clone();
    sorted.sort();

    assert_eq!(
        sorted
            .iter()
            .map(|player| player.name.as_str())
            .collect::<Vec<_>>(),
        ["Charlie", "Alice", "Eve", "Bob", "David"]
    );
    assert_eq!(Vote::Hidden.to_string(), "Hidden");
    assert_eq!(GamePhase::Unknown.to_string(), "Unknown");
    assert_eq!(sorted[0].cmp(&sorted[1]), Ordering::Less);
}

#[test]
fn web_serialization_uses_core_names_safe_milliseconds_and_nulls() {
    let entry = HistoryEntry {
        round_number: 2,
        average: None,
        votes: vec![Player {
            name: "Alice".to_string(),
            vote: Vote::Revealed(VoteData::Number(5)),
            is_you: true,
            user_type: UserType::Player,
        }],
        deck: vec!["5".to_string()],
        own_vote: None,
    };

    assert_eq!(
        serde_json::to_value(entry).unwrap(),
        serde_json::json!({
            "roundNumber": 2,
            "average": null,
            "votes": [{
                "name": "Alice",
                "vote": { "state": "revealed", "value": { "kind": "number", "value": 5 } },
                "isYou": true,
                "userType": "player"
            }],
            "deck": ["5"],
            "ownVote": null
        })
    );

    let unsafe_entry = LogEntry {
        timestamp: Duration::from_millis((MAX_SAFE_INTEGER + 1) as u64),
        level: LogLevel::Info,
        message: String::new(),
        source: LogSource::Client,
        server_index: None,
    };
    assert!(serde_json::to_value(unsafe_entry).is_err());
}
