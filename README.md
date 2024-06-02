# ppoker - Planning Poker in your terminal

## Client

This is an alternative, cross-platform terminal client to the planning poker server provided by
[pp](https://github.com/sne11ius/pp). It's designed to be used with a keyboard only, without relying on a mouse for
input. The user interface is highly opinionated and probably not suited for everyone, relying heavily on keyboard
shortcuts.

## Installation

Download the current version for your operating system from [the release page](https://github.com/ja-ko/ppoker/releases).

## Usage

### How to run
```shell
./ppoker <roomname>
```
That's it. 

The name of a room is optional, if omitted a room is generated automatically. 

### Commandline arguments
```
Usage: ppoker.exe [OPTIONS] [ROOM]

Arguments:
  [ROOM]  Room to join

Options:
  -n, --name <NAME>        Name to use for this session
  -s, --server <SERVER>    Websocket URL to connect to
  -S, --skip-update-check  Skip the automatic update check and stay on the current version
  -h, --help               Print help
  -V, --version            Print version
```

You can also use environment variables to set each argument or option. For this prefix the option name with 
`PPOKER_`. For example: `PPOKER_ROOM=planning-room ./ppoker`


### Config file

You can set defaults for the commandline arguments by providing a config file in `.toml` format at the following 
location:

| Platform | Value                                                                       |
|----------|-----------------------------------------------------------------------------|
| Linux    | `$XDG_CONFIG_HOME/ppoker/config.toml` or `$HOME/.config/ppoker/config.toml` |
| macOS    | `$HOME/Library/Application Support/dev.jko-ppoker/config.toml`              |
| Windows  | `%APPDATA%\ppoker\config\config.toml`                                       |

Create a `config.toml` with any of the following keys:
```toml 
name = "ja-ko"
room = "planning-room"
server = "wss://pp.discordia.network/"
skip_update_check = false
```
