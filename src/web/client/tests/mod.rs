use super::{connect, wait_for_initial_room};
use crate::app::tests::create_test_app;
use crate::app::{test_room_event, test_snapshot_event, App};
use crate::config::Config;
use crate::models::{GamePhase, LogLevel, LogSource, Player, Room, UserType, Vote, VoteData};
use ppoker_core::client::{Client, Transport, TransportEvent};
use ppoker_core::protocol::{RoomSnapshot, ServerLogEntry};
use std::cell::RefCell;
use std::collections::HashMap;
use std::collections::VecDeque;
use std::rc::Rc;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const LIVE_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(12);

#[derive(Debug, serde::Deserialize, PartialEq, Eq)]
#[serde(tag = "requestType")]
enum TestClientRequest {
    PlayCard {
        #[serde(rename = "cardValue")]
        card_value: Option<String>,
    },
    ChangeName {
        name: String,
    },
    ChatMessage {
        message: String,
    },
    RevealCards,
    StartNewRound,
}

fn decode_client_request(message: &str) -> Result<TestClientRequest, serde_json::Error> {
    serde_json::from_str(message)
}

#[derive(Default)]
struct BufferedTransportState {
    events: VecDeque<TransportEvent>,
    closes: usize,
}

struct BufferedTransport(Rc<RefCell<BufferedTransportState>>);

impl Transport for BufferedTransport {
    fn poll_event(&mut self) -> Option<TransportEvent> {
        self.0.borrow_mut().events.pop_front()
    }

    fn send_text(&mut self, _message: String) -> Result<(), String> {
        Ok(())
    }

    fn close(&mut self) {
        self.0.borrow_mut().closes += 1;
    }
}

fn room_event(phase: GamePhase, vote: Vote) -> TransportEvent {
    room_with_players_event(phase, vec![player("Alice", vote, true)])
}

fn player(name: &str, vote: Vote, is_you: bool) -> Player {
    Player {
        name: name.to_string(),
        vote,
        is_you,
        user_type: UserType::Player,
    }
}

fn two_player_event(own_vote: Vote, other_vote: Vote) -> TransportEvent {
    room_with_players_event(
        GamePhase::Playing,
        vec![
            player("Alice", own_vote, true),
            player("Bob", other_vote, false),
        ],
    )
}

fn room_with_players_event(phase: GamePhase, players: Vec<Player>) -> TransportEvent {
    test_room_event(Room {
        name: "startup-room".to_string(),
        deck: vec!["5".to_string()],
        phase,
        players,
    })
}

fn buffered_startup(
    events: impl IntoIterator<Item = TransportEvent>,
) -> (Client, Rc<RefCell<BufferedTransportState>>) {
    let state = Rc::new(RefCell::new(BufferedTransportState {
        events: events.into_iter().collect(),
        ..BufferedTransportState::default()
    }));
    let client = wait_for_initial_room(
        "Alice".to_string(),
        Box::new(BufferedTransport(state.clone())),
        |_| {},
    )
    .unwrap();
    (client, state)
}

#[test]
fn startup_stops_at_first_room_and_leaves_every_later_event_buffered() {
    for tail in [
        room_event(GamePhase::Revealed, Vote::Revealed(VoteData::Number(5))),
        TransportEvent::Closed,
        TransportEvent::Error("startup transport failed".to_string()),
    ] {
        let (client, state) = buffered_startup([
            TransportEvent::Opened,
            room_event(GamePhase::Playing, Vote::Missing),
            tail,
        ]);
        assert_eq!(client.room().unwrap().phase, GamePhase::Playing);
        assert!(client.history().is_empty());
        assert_eq!(state.borrow().events.len(), 1);
    }
}

#[test]
fn app_processes_post_startup_notification_and_auto_reveal_transitions_in_order() {
    let (client, _) = buffered_startup([
        TransportEvent::Opened,
        two_player_event(Vote::Missing, Vote::Missing),
        two_player_event(Vote::Missing, Vote::Hidden),
        two_player_event(Vote::Revealed(VoteData::Number(5)), Vote::Hidden),
    ]);
    let config = Config::default();
    let mut app = App::from_client(config, client);

    app.update().unwrap();

    assert!(app.has_updates);
    assert!(app.auto_reveal_at.is_some());
    assert!(app
        .activity_log()
        .iter()
        .any(|entry| entry.message == "Your vote is the last one missing."));
    assert_eq!(app.own_vote(), &Some(VoteData::Number(5)));
}

#[test]
fn startup_wait_remains_bounded_when_no_room_arrives() {
    let state = Rc::new(RefCell::new(BufferedTransportState::default()));
    let waits = Rc::new(RefCell::new(vec![]));
    let recorded_waits = waits.clone();

    let error = wait_for_initial_room(
        "Alice".to_string(),
        Box::new(BufferedTransport(state.clone())),
        move |duration| recorded_waits.borrow_mut().push(duration),
    )
    .err()
    .expect("startup without a room should time out");

    assert_eq!(
        error.to_string(),
        "Server did not send room update in time."
    );
    assert_eq!(waits.borrow().as_slice(), [Duration::from_millis(20); 20]);
    assert_eq!(state.borrow().closes, 1);
}

#[derive(Debug, Clone)]
struct LocalUser {
    name: String,
    actual_vote: Option<String>,
    user_type: UserType,
}

impl LocalUser {
    fn new(name: &str, user_type: UserType) -> Self {
        Self {
            name: name.to_string(),
            actual_vote: None,
            user_type,
        }
    }

    fn participant(&self, is_you: bool, cards_revealed: bool) -> Player {
        let vote = match &self.actual_vote {
            Some(value) if is_you || cards_revealed => Vote::Revealed(
                value
                    .parse::<u8>()
                    .map(VoteData::Number)
                    .unwrap_or_else(|_| VoteData::Special(value.clone())),
            ),
            Some(_) => Vote::Hidden,
            None => Vote::Missing,
        };
        Player {
            name: self.name.clone(),
            vote,
            is_you,
            user_type: self.user_type.clone(),
        }
    }
}

#[derive(Debug)]
struct LocalServer {
    current_user: LocalUser,
    other_users: HashMap<String, LocalUser>,
    cards_revealed: bool,
    pending_updates: VecDeque<Room>,
    log_entries: Vec<ServerLogEntry>,
    next_user_id: u32,
    opened_pending: bool,
}

impl LocalServer {
    fn new(username: &str) -> Self {
        let mut server = Self {
            current_user: LocalUser::new(username, UserType::Player),
            other_users: HashMap::new(),
            cards_revealed: false,
            pending_updates: VecDeque::new(),
            log_entries: Vec::new(),
            next_user_id: 1,
            opened_pending: true,
        };
        server.commit(format!("{username} joined the room"));
        server
    }

    fn add_participant(&mut self, name: &str, user_type: UserType) -> String {
        let spectator = user_type == UserType::Spectator;
        let separator = if spectator { '_' } else { '-' };
        let user_id = format!("user{separator}{}", self.next_user_id);
        self.next_user_id += 1;
        self.other_users
            .insert(user_id.clone(), LocalUser::new(name, user_type));
        let suffix = if spectator {
            " joined as spectator"
        } else {
            " joined the room"
        };
        self.commit(format!("{name}{suffix}"));
        user_id
    }

    fn add_spectator(&mut self, username: &str) -> String {
        self.add_participant(username, UserType::Spectator)
    }

    fn add_user(&mut self, name: &str) -> String {
        self.add_participant(name, UserType::Player)
    }

    fn commit(&mut self, message: String) {
        self.log_entries.push(ServerLogEntry {
            level: LogLevel::Info,
            message,
            server_index: self.log_entries.len() as u32,
        });
        self.queue_room_update();
    }

    fn queue_room_update(&mut self) {
        let mut players = vec![self.current_user.participant(true, self.cards_revealed)];
        players.extend(
            self.other_users
                .values()
                .map(|user| user.participant(false, self.cards_revealed)),
        );
        players.sort_by_key(|p| match p.user_type {
            UserType::Player => 0,
            UserType::Spectator => 1,
            UserType::Unknown => 2,
        });
        self.pending_updates.push_back(Room {
            name: "Planning Room".to_string(),
            deck: ["0", "1", "2", "3", "5", "8", "13", "21", "?"]
                .map(str::to_string)
                .to_vec(),
            phase: if self.cards_revealed {
                GamePhase::Revealed
            } else {
                GamePhase::Playing
            },
            players,
        });
    }

    fn user_vote(&mut self, user_id: &str, card_value: Option<&str>) {
        if let Some(user) = self.other_users.get_mut(user_id) {
            let name = user.name.clone();
            user.actual_vote = card_value.map(str::to_string);
            let action = if card_value.is_some() {
                "played a card"
            } else {
                "removed their card"
            };
            self.commit(format!("{name} {action}"));
        }
    }

    fn vote(&mut self, card_value: &str) {
        let name = self.current_user.name.clone();
        self.current_user.actual_vote = Some(card_value.to_string());
        self.commit(format!("{name} played a card"));
    }

    fn retract_vote(&mut self) {
        let name = self.current_user.name.clone();
        self.current_user.actual_vote = None;
        self.commit(format!("{name} removed their card"));
    }

    fn change_name(&mut self, name: &str) {
        let old_name = self.current_user.name.clone();
        self.current_user.name = name.to_string();
        self.commit(format!("{old_name} changed their name to {name}"));
    }

    fn chat(&mut self, message: &str) {
        self.commit(format!("{}: {message}", self.current_user.name));
    }

    fn reveal(&mut self) {
        if !self.cards_revealed {
            self.cards_revealed = true;
            self.commit(format!("{} revealed all cards", self.current_user.name));
        }
    }

    fn reset(&mut self) {
        self.cards_revealed = false;
        self.current_user.actual_vote = None;
        for user in self.other_users.values_mut() {
            user.actual_vote = None;
        }
        self.commit(format!("{} started a new round", self.current_user.name));
    }
}

#[derive(Clone)]
pub struct LocalTestTransport(Rc<RefCell<LocalServer>>);

impl LocalTestTransport {
    pub fn new(username: &str) -> Self {
        Self(Rc::new(RefCell::new(LocalServer::new(username))))
    }

    pub fn add_spectator(&self, username: &str) -> String {
        self.0.borrow_mut().add_spectator(username)
    }

    pub fn add_user(&self, name: &str) -> String {
        self.0.borrow_mut().add_user(name)
    }

    pub fn user_vote(&self, user_id: &str, card_value: Option<&str>) {
        self.0.borrow_mut().user_vote(user_id, card_value);
    }
}

impl Transport for LocalTestTransport {
    fn poll_event(&mut self) -> Option<TransportEvent> {
        let mut server = self.0.borrow_mut();
        if server.opened_pending {
            server.opened_pending = false;
            return Some(TransportEvent::Opened);
        }
        let room = server.pending_updates.pop_front()?;
        Some(test_snapshot_event(RoomSnapshot {
            room,
            log: server.log_entries.clone(),
        }))
    }

    fn send_text(&mut self, message: String) -> Result<(), String> {
        let request = decode_client_request(&message)
            .map_err(|error| format!("Invalid local test request: {error}"))?;
        let mut server = self.0.borrow_mut();
        match request {
            TestClientRequest::PlayCard {
                card_value: Some(value),
            } => server.vote(&value),
            TestClientRequest::PlayCard { card_value: None } => server.retract_vote(),
            TestClientRequest::ChangeName { name } => server.change_name(&name),
            TestClientRequest::ChatMessage { message } => server.chat(&message),
            TestClientRequest::RevealCards => server.reveal(),
            TestClientRequest::StartNewRound => server.reset(),
        }
        Ok(())
    }

    fn close(&mut self) {}
}

#[test]
fn local_transport_and_app_commit_escaped_rename_and_chat_authoritatively() {
    let mut app = create_test_app(Box::new(LocalTestTransport::new("Alice")));
    let name = "Ålice \"quoted\"\n東京";
    let message = "line \"two\"\n世界 ☕";

    app.rename(name.to_string()).unwrap();
    app.chat(message.to_string()).unwrap();
    assert_eq!(app.name(), "Test User");
    assert!(!app
        .activity_log()
        .iter()
        .any(|entry| entry.message.contains(message)));

    app.update().unwrap();
    assert_eq!(app.name(), name);
    let log = app.activity_log();
    assert!(log
        .iter()
        .any(|entry| entry.message == format!("Alice changed their name to {name}")));
    assert!(log
        .iter()
        .any(|entry| entry.message == format!("{name}: {message}")));
}

fn run_live_native_attempt(mut config: Config) -> Result<(), String> {
    let room_name = config.room.clone();
    let participant_prefix = config.name.clone();
    let first_name = format!("{participant_prefix}-first");
    let second_name = format!("{participant_prefix}-second");
    let chat_message = format!("authoritative-chat-{participant_prefix}");
    config.name.clone_from(&first_name);
    let mut second_config = config.clone();
    second_config.name.clone_from(&second_name);

    let mut client1 = App::new(config)
        .map_err(|error| format!("first participant connection failed: {error}"))?;
    let mut client2 = connect(&second_config)
        .map_err(|error| format!("second participant connection failed: {error}"))?;
    client1
        .vote("5")
        .map_err(|error| format!("first participant vote failed: {error}"))?;
    client1
        .chat(chat_message.clone())
        .map_err(|error| format!("first participant chat failed: {error}"))?;
    thread::sleep(Duration::from_millis(25));
    client2
        .vote("3")
        .map_err(|error| format!("second participant vote failed: {error}"))?;

    let deadline = Instant::now() + Duration::from_secs(4);
    loop {
        client1
            .update()
            .map_err(|error| format!("first participant poll failed: {error}"))?;
        client2
            .poll()
            .map_err(|error| format!("second participant poll failed: {error}"))?;

        let first_room = client1.room();
        let second_room = client2
            .room()
            .ok_or_else(|| "second participant has no room snapshot".to_string())?;
        let first_room_confirmed = first_room.name == room_name;
        let second_room_confirmed = second_room.name == room_name;
        let first_vote_confirmed = first_room.players.iter().any(|player| {
            player.is_you
                && player.name == first_name
                && player.vote == Vote::Revealed(VoteData::Number(5))
        });
        let second_vote_confirmed = second_room.players.iter().any(|player| {
            player.is_you
                && player.name == second_name
                && player.vote == Vote::Revealed(VoteData::Number(3))
        });
        let expected_chat = format!("[{first_name}]: {chat_message}");
        let chat_confirmed = client1
            .activity_log()
            .iter()
            .any(|entry| entry.source == LogSource::Server && entry.message == expected_chat);
        let first_players_confirmed = first_room.players.len() == 2
            && first_room
                .players
                .iter()
                .any(|player| !player.is_you && player.name == second_name);
        let second_players_confirmed = second_room.players.len() == 2
            && second_room
                .players
                .iter()
                .any(|player| !player.is_you && player.name == first_name);

        if first_room_confirmed
            && second_room_confirmed
            && first_players_confirmed
            && second_players_confirmed
            && first_vote_confirmed
            && second_vote_confirmed
            && chat_confirmed
        {
            return Ok(());
        }
        if Instant::now() >= deadline {
            let first_log = client1
                .activity_log()
                .into_iter()
                .map(|entry| (entry.source, entry.message.as_str()))
                .collect::<Vec<_>>();
            return Err(format!(
                "timed out waiting for authoritative state in room {room_name:?}: first_room={:?} ({first_room_confirmed}), second_room={:?} ({second_room_confirmed}), first_players={:?} ({first_players_confirmed}), second_players={:?} ({second_players_confirmed}), first_vote={first_vote_confirmed}, second_vote={second_vote_confirmed}, expected_chat={expected_chat:?}, chat={chat_confirmed}, first_log={first_log:?}",
                first_room.name,
                second_room.name,
                first_room.players,
                second_room.players,
            ));
        }
        thread::sleep(Duration::from_millis(50));
    }
}

#[test]
#[ignore = "requires the live upstream Planning Poker server"]
fn real_upstream_accepts_native_participants() {
    let unique = format!(
        "{}-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after the Unix epoch")
            .as_nanos(),
        std::process::id()
    );
    let mut failures = vec![];

    for attempt in 1..=3 {
        let config = Config {
            room: format!("native-live-{unique}-{attempt}"),
            name: format!("native-live-participant-{unique}-{attempt}"),
            ..Config::default()
        };
        let room_name = config.room.clone();
        let participant_prefix = config.name.clone();
        let (result_tx, result_rx) = mpsc::channel();
        let worker = thread::Builder::new()
            .name(format!("native-live-{attempt}"))
            .spawn(move || {
                let started = Instant::now();
                let result = run_live_native_attempt(config);
                let _ = result_tx.send((started.elapsed(), result));
            })
            .unwrap_or_else(|error| panic!("failed to spawn live attempt {attempt}: {error}"));

        match result_rx.recv_timeout(LIVE_ATTEMPT_TIMEOUT) {
            Ok((elapsed, Ok(()))) => {
                println!(
                    "native live attempt {attempt} passed in {elapsed:?} (room={room_name}, participants={participant_prefix}-first,{participant_prefix}-second)"
                );
                drop(worker);
                return;
            }
            Ok((elapsed, Err(error))) => {
                failures.push(format!(
                    "attempt {attempt} failed after {elapsed:?} (room={room_name}): {error}"
                ));
                drop(worker);
            }
            Err(RecvTimeoutError::Timeout) => {
                failures.push(format!(
                    "attempt {attempt} exceeded the {LIVE_ATTEMPT_TIMEOUT:?} hard timeout (room={room_name}, participants={participant_prefix}-first,{participant_prefix}-second); detached blocked worker"
                ));
                // A detached worker cannot delay test-process exit if connect stays blocked.
                drop(result_rx);
                drop(worker);
            }
            Err(RecvTimeoutError::Disconnected) => {
                let diagnostic = match worker.join() {
                    Ok(()) => "worker exited without reporting a result".to_string(),
                    Err(payload) => payload
                        .downcast_ref::<&str>()
                        .map(|message| (*message).to_string())
                        .or_else(|| payload.downcast_ref::<String>().cloned())
                        .unwrap_or_else(|| "worker panicked with a non-string payload".to_string()),
                };
                failures.push(format!(
                    "attempt {attempt} worker failed (room={room_name}): {diagnostic}"
                ));
            }
        }
    }

    panic!(
        "real upstream native participant test failed: {}",
        failures.join("; ")
    );
}
