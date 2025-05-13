# ppoker - Planning Poker in your terminal

![GitHub Actions Workflow Status](https://img.shields.io/github/actions/workflow/status/ja-ko/ppoker/build.yml)
[![GitHub Release](https://img.shields.io/github/v/release/ja-ko/ppoker)](https://github.com/ja-ko/ppoker/releases)
[![codecov](https://codecov.io/gh/ja-ko/ppoker/graph/badge.svg?token=FGE02UNPW4)](https://codecov.io/gh/ja-ko/ppoker)
![GitHub License](https://img.shields.io/github/license/ja-ko/ppoker?color=%23003399)

## Client

This is an alternative, cross-platform terminal client to the planning poker server provided by
[pp](https://github.com/sne11ius/pp). It's designed to be used with a keyboard only, without relying on a mouse for
input. The user interface is highly opinionated and probably not suited for everyone, relying heavily on keyboard
shortcuts.

## Installation

Download the current version for your operating system from
[the release page](https://github.com/ja-ko/ppoker/releases) or use the following direct links:

<!-- x-release-please-start-version -->

* [Linux](https://github.com/ja-ko/ppoker/releases/download/v0.5.0/ppoker-x86_64-unknown-linux-gnu.tar.gz)
* [Windows](https://github.com/ja-ko/ppoker/releases/download/v0.5.0/ppoker-x86_64-pc-windows-msvc.zip)
* [Mac](https://github.com/ja-ko/ppoker/releases/download/v0.5.0/ppoker-x86_64-apple-darwin.tar.gz)

<!-- x-release-please-end -->

## Usage

### How to run
```shell
./ppoker <roomname>
```
That's it.

The name of a room is optional, if omitted a room is generated automatically.

### Commandline arguments
```
Client for planning poker - https://github.com/sne11ius/pp

Usage: ppoker [OPTIONS] [ROOM]

Arguments:
  [ROOM]  Room to join

Options:
  -n, --name <NAME>            Name to use for this session
  -s, --server <SERVER>        Websocket URL to connect to
  -A, --disable-auto-reveal    Disables automatic reveal of cards
  -S, --skip-update-check      Skip the automatic update check and stay on the current version
  -N, --disable-notifications  Disable notifications
  -h, --help                   Print help
  -V, --version                Print version
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
disable_auto_reveal = false
skip_update_check = false
disable_notifications = false
keep_backup_on_update = true
```
