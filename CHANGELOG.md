# Changelog

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
