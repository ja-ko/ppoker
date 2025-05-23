# Changelog

## [0.5.4](https://github.com/ja-ko/ppoker/compare/v0.5.3...v0.5.4) (2025-05-23)


### Bug Fixes

* add support for handling unknown enum variants ([fd243ee](https://github.com/ja-ko/ppoker/commit/fd243ee58b03a53f2747d74d8205a63b48d61bfa))

## [0.5.3](https://github.com/ja-ko/ppoker/compare/v0.5.2...v0.5.3) (2025-05-16)


### Features

* **text_input:** add Ctrl+Arrow support for word-wise cursor navigation ([add3eed](https://github.com/ja-ko/ppoker/commit/add3eed84b6d73c819bbe217d605f1522686f5b6))
* **ui/voting:** add input cancellation via Ctrl+C ([bab1a32](https://github.com/ja-ko/ppoker/commit/bab1a32cab39086b9efec347e1b3e8233b6373bb))


### Bug Fixes

* **config:** Fix skip_update_check being ignored from toml config ([ee050ba](https://github.com/ja-ko/ppoker/commit/ee050ba22c4d5e5f83bc6fc90edb34459b24f66b))
* **config:** some test runners were failing config tests by passing cli arguments ([dab873f](https://github.com/ja-ko/ppoker/commit/dab873f550859d42d8d83bb4e5de16d9d1f6c097))
* no longer print the wrong log message when a user cancels an update ([6d0bacd](https://github.com/ja-ko/ppoker/commit/6d0bacda22ea9d405576513a64af4b1e084df951))

## [0.5.2](https://github.com/ja-ko/ppoker/compare/v0.5.1...v0.5.2) (2025-05-15)


### Bug Fixes

* **changelog:** replace the `NoBold` attribute with `NormalIntensity` ([2828a06](https://github.com/ja-ko/ppoker/commit/2828a06631c5c5392afbc484effbc57000d14d01))

## [0.5.1](https://github.com/ja-ko/ppoker/compare/v0.5.0...v0.5.1) (2025-05-15)


### Features

* **update:** remove interactive prompt for changelog display ([861f4de](https://github.com/ja-ko/ppoker/commit/861f4defabc057e520a3f9be92aafc22193c4eb8))


### Bug Fixes

* **ui/history:** resolve incorrect player sorting in history view ([b9164a9](https://github.com/ja-ko/ppoker/commit/b9164a9647f8264b0bb4393584fe927a9a8b2079))

## [0.5.0](https://github.com/ja-ko/ppoker/compare/v0.4.2...v0.5.0) (2025-05-11)


### Features

* **ui:** add cursor navigation and editing support in text input ([4c823a3](https://github.com/ja-ko/ppoker/commit/4c823a395d0aacd55c6ecafacc4b0dfb9d072bea)), closes [#61](https://github.com/ja-ko/ppoker/issues/61)
* **ui:** sanitize input strings across voting UI ([9acb561](https://github.com/ja-ko/ppoker/commit/9acb5611143d01f19c5a6fa22dbf337299c24c34)), closes [#59](https://github.com/ja-ko/ppoker/issues/59)
* **update:** add binary backup support during updates ([3069818](https://github.com/ja-ko/ppoker/commit/306981862166eafdefb0c43f0e1f9b3bd3c62ab5))
* **update:** add changelog parsing and display for updates ([03a1cab](https://github.com/ja-ko/ppoker/commit/03a1cab3097dd41066023e4a9b29c910c37bbbd8))
* **update:** add rich terminal rendering for changelog display ([2018401](https://github.com/ja-ko/ppoker/commit/2018401b9a60d592bfd8d737baefa33d6ede32e5))


### Bug Fixes

* cursor not moving right on right press. ([6247234](https://github.com/ja-ko/ppoker/commit/6247234fa77dd7c536d44f1e886131b029ea5e7a))
* **ui:** correct cursor position in input box rendering ([48be407](https://github.com/ja-ko/ppoker/commit/48be407b02eff6778687275d65bb9a00e8e16601)), closes [#60](https://github.com/ja-ko/ppoker/issues/60)
* **ui:** fix a crash that occurred when navigating right through multibyte character ([094114d](https://github.com/ja-ko/ppoker/commit/094114dcab0d21628a043cc9a8399b4cbbf83004))


### Miscellaneous Chores

* release 0.5.0 ([26244d9](https://github.com/ja-ko/ppoker/commit/26244d9f3abaebde0914bff03417e9a01d145de1))

## [0.4.2](https://github.com/ja-ko/ppoker/compare/v0.4.1...v0.4.2) (2025-04-23)


### Bug Fixes

* release with ubuntu 22.04 ([818096b](https://github.com/ja-ko/ppoker/commit/818096becdd6d52bab22443c5c12b06aff73f72c))

## [0.4.1](https://github.com/ja-ko/ppoker/compare/v0.4.0...v0.4.1) (2025-04-23)


### Bug Fixes

* build with ubuntu 22.04 ([690db80](https://github.com/ja-ko/ppoker/commit/690db80bce524e050e94d7baa8ac8105e682b235))

## [0.4.0](https://github.com/ja-ko/ppoker/compare/v0.3.2...v0.4.0) (2025-04-22)


### Features

* add auto-reveal functionality with configurable toggle ([19cd065](https://github.com/ja-ko/ppoker/commit/19cd06548437e353d8d0571d337b49eca6ca9628))
* **app:** ring terminal bell when notification ([5cc17e2](https://github.com/ja-ko/ppoker/commit/5cc17e21a70f92609752d8b533c3254c34ca68c5))
* **ui:** add separate spectator section in voting layout ([b751bcb](https://github.com/ja-ko/ppoker/commit/b751bcb1caec0b25b7b3cbc8ad4e369a0bd7cc81))


### Bug Fixes

* **app:** check cancel auto-reveal only on room updates ([ac7393f](https://github.com/ja-ko/ppoker/commit/ac7393fef0e1aeeb92abd960e156bf343e63e116))
* **app:** exclude spectators from missing vote calculations ([975879a](https://github.com/ja-ko/ppoker/commit/975879aab8326635eef0bc3453de4db2816a8592))
* **app:** propagate retracting a vote to the server ([dd8085b](https://github.com/ja-ko/ppoker/commit/dd8085bbdf726c985992992a8bddc260353bb3f7))
* decrease notification delay ([df170c1](https://github.com/ja-ko/ppoker/commit/df170c19a6c325c8b7055e08d0513a87f68fecbc))
* prevent redundant client actions ([9e3f9fd](https://github.com/ja-ko/ppoker/commit/9e3f9fd9f6156cf8cbfbf7493c5f3043c060847c))


### Miscellaneous Chores

* prepare release 0.4.0 ([9da5a4b](https://github.com/ja-ko/ppoker/commit/9da5a4b6f022a94f9ea567c5a01a9356bf11862f))

## [0.3.2](https://github.com/ja-ko/ppoker/compare/v0.3.1...v0.3.2) (2024-06-13)


### Features

* **ui:** display player type in vote view ([2afeba7](https://github.com/ja-ko/ppoker/commit/2afeba762cc911726ca6786878c59be6672bcdcc))

## [0.3.1](https://github.com/ja-ko/ppoker/compare/v0.3.0...v0.3.1) (2024-06-09)


### Bug Fixes

* fixes the failing build on macos ([54347d6](https://github.com/ja-ko/ppoker/commit/54347d615e456716e5e9555cc2c0082cd937949b))

## [0.3.0](https://github.com/ja-ko/ppoker/compare/v0.2.6...v0.3.0) (2024-06-09)


### Features

* **app:** add history page. ([5f0ea9e](https://github.com/ja-ko/ppoker/commit/5f0ea9e96da4d6537c0c99ffcbdd158d08b11e19))
* **app:** display round duration for each round. ([b389bdf](https://github.com/ja-ko/ppoker/commit/b389bdfdc48d10e45df94af457aa64370438b368))
* **app:** Emit notification sound on linux ([9ed9ac1](https://github.com/ja-ko/ppoker/commit/9ed9ac117730cf722daa2689a14a10f0bc917b40))
* **app:** indicate if state changes while in history ([e0bd3fd](https://github.com/ja-ko/ppoker/commit/e0bd3fdd6ac4de37256696c98cf1d362795176c0))
* **app:** keep votes consistent when player leaves. ([78eabdf](https://github.com/ja-ko/ppoker/commit/78eabdff6385163ed5ed3ab9500302c3b0fca947))
* **ui:** include change marker in the header on history ([53c2a23](https://github.com/ja-ko/ppoker/commit/53c2a23f81dae00314a9bd4d80f3a09875ea94df))
* **ui:** make notification colour in history better visible ([a64b3b9](https://github.com/ja-ko/ppoker/commit/a64b3b9f68f807571f1933932350ee6d40507497))
* **ui:** print client notifications in yellow ([357ccb0](https://github.com/ja-ko/ppoker/commit/357ccb02a403947d79adb58a5c1aa0a274197979))
* **ui:** stabilize player order ([f4ea2c5](https://github.com/ja-ko/ppoker/commit/f4ea2c5931543485ce3a2126f2710de190acbd02))


### Bug Fixes

* clarify some ui texts. ([535006d](https://github.com/ja-ko/ppoker/commit/535006d7abb53c4cf9fbc5c7696bf8719b314f8f))
* define ordering of players on history page. ([346bf95](https://github.com/ja-ko/ppoker/commit/346bf9508bab24e2b394abdd573ddebaf4563bf8))
* **ui:** fix the round timer not working properly in some situations ([c8d7a99](https://github.com/ja-ko/ppoker/commit/c8d7a99ce821358a17380c02a0522079c938e13f))


### Miscellaneous Chores

* bump release version ([dd87410](https://github.com/ja-ko/ppoker/commit/dd87410ed1949eefe66418cc0035491fb93dcb07))

## [0.2.6](https://github.com/ja-ko/ppoker/compare/v0.2.5...v0.2.6) (2024-06-03)


### Bug Fixes

* **network:** fix application hanging when connecting to a non tls websocket. ([0ce3a41](https://github.com/ja-ko/ppoker/commit/0ce3a4178c69bcb3511f442a32b602352ddf7949))

## [0.2.5](https://github.com/ja-ko/ppoker/compare/v0.2.4...v0.2.5) (2024-06-03)


### Bug Fixes

* **ui:** avoid a crash related to unicode characters in long names ([f04c881](https://github.com/ja-ko/ppoker/commit/f04c88183ebeeb28a9f461ba75f0587805f639a0))
* **ui:** hide input box when phase is changed ([d3afe84](https://github.com/ja-ko/ppoker/commit/d3afe84223a5c300541d856db4e3caf43908927c))
* **ui:** hide ws debug logs by default ([2bf3638](https://github.com/ja-ko/ppoker/commit/2bf36389269f6e3cac112ba1995066ac4acaa6c9))

## [0.2.4](https://github.com/ja-ko/ppoker/compare/ppoker-v0.2.3...ppoker-v0.2.4) (2024-06-03)


### Bug Fixes

* **log:** write logs on panic or exit. ([7f3f093](https://github.com/ja-ko/ppoker/commit/7f3f0939c2a807aa6151e13ec6c75b2030627ab3))
* **ui:** Cleanly shutdown the tui before exitting on error ([0e39e86](https://github.com/ja-ko/ppoker/commit/0e39e86edf90b27641f4736cfd226b0a1b021fdf))
* **ui:** no longer interpret newlines when pasted. ([e899534](https://github.com/ja-ko/ppoker/commit/e899534ffc8ba3ce8bdd65f4df1b05c0205f437e))

## [0.2.3](https://github.com/ja-ko/ppoker/compare/v0.2.2...v0.2.3) (2024-06-03)


### Bug Fixes

* **app:** allow voting of non numeric cards in deck. ([3ab1abd](https://github.com/ja-ko/ppoker/commit/3ab1abdf609f9a0e0e3a4b7788f816c6f75c9a9d))
* **ui:** hide the confirm dialog if someone else switches phase ([42f25ac](https://github.com/ja-ko/ppoker/commit/42f25ac2b20913c745eb2666e7400db372046429))
* **ui:** remove newlines from input values ([0cd09ae](https://github.com/ja-ko/ppoker/commit/0cd09ae3b2d94a8bb3fdbd87fc74f2aa4713a1aa))

## [0.2.2](https://github.com/ja-ko/ppoker/compare/v0.2.1...v0.2.2) (2024-06-02)


### Bug Fixes

* **updater:** fix updater not working with compressed tar images ([fa28fab](https://github.com/ja-ko/ppoker/commit/fa28fab077989e2e81b0d374496b5ffbaa0f4424))
* **updater:** start application if user cancels update ([aa3b68e](https://github.com/ja-ko/ppoker/commit/aa3b68eac8f802205a0ac75041135223e1b96879))

## [0.2.1](https://github.com/ja-ko/ppoker/compare/v0.2.0...v0.2.1) (2024-06-02)


### Bug Fixes

* **updater:** fix updater being unable to create the temporary archive file. ([8055ca5](https://github.com/ja-ko/ppoker/commit/8055ca53a86e3aef333950d35fc392492855f033))
* **updater:** fix updater stopping the application when no asset is found. ([6d87f68](https://github.com/ja-ko/ppoker/commit/6d87f68661f1c91098c5a6beb8c2cd449750edd2))

## [0.2.0](https://github.com/ja-ko/ppoker/compare/v0.1.0...v0.2.0) (2024-06-02)


### Features

* **app:** add options to disable notifications ([a5a37df](https://github.com/ja-ko/ppoker/commit/a5a37dfced2face45220a694c63ca0b18aefa3c9))
* **app:** Notify user when their vote is the last one missing. ([32fb480](https://github.com/ja-ko/ppoker/commit/32fb48003ae3af9b221dfcef288f95e7e88a2a0f))
* **ui:** Show current round number. ([4774903](https://github.com/ja-ko/ppoker/commit/4774903bc9c45e5436e8706d814ac88b23bde7d2))


### Bug Fixes

* **app:** enable focus change events on linux ([07d94f6](https://github.com/ja-ko/ppoker/commit/07d94f65e8c7113e22c44a8c786ad36b5b5d5a20))
* **app:** fixes build on linux ([3dd8001](https://github.com/ja-ko/ppoker/commit/3dd800137c10780f9ede64927e6b6a80265c8d6f))
* **cargo:** fixes warnings ([9963f74](https://github.com/ja-ko/ppoker/commit/9963f74c0f4f4f7cf5968266bf82ee4dca675966))
* **config:** make the disable flags actually work. ([e32ec4b](https://github.com/ja-ko/ppoker/commit/e32ec4b1830a167c434b1eccc43a6cb0f78e8d43))
* **updater:** add options to disable auto updates. ([cb0abc9](https://github.com/ja-ko/ppoker/commit/cb0abc9dd2a18ebbfed9216037ed7696a413c847))
* **updater:** rework update prompt and error handling. ([b0a4f28](https://github.com/ja-ko/ppoker/commit/b0a4f281400c91e814dc028877f8412064790db0))

## 0.1.0 (2024-06-02)


### Features

* **main:** Introduce auto updater ([a8a73bd](https://github.com/ja-ko/ppoker/commit/a8a73bd91deabab9b2de1d56b8c244f37443a423))


### Bug Fixes

* **cargo:** Split self_update features based on os. ([3583188](https://github.com/ja-ko/ppoker/commit/35831880d03be1b65a81be196fbe3d508f3150ed))
