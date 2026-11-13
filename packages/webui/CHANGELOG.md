# Changelog

## [20261114]

### Added

- A chat shows what it cost: a meta row under each reply (context sent, output, cache hit rate, cost) and a composer dock with the session totals. Totals are summed over the branch the session file ends on, so a fork or a retry does not charge a span twice, and a compacted branch says the number is unavailable instead of reporting a doubled sum (issue [#596](https://cnb.cool/shinytale/nanopi/-/issues/596))
- Adding a provider account has an account id field: without one the second account of the same protocol always collided with the first. The preset also writes the api id the runtime registers instead of the listing protocol (issue [#609](https://cnb.cool/shinytale/nanopi/-/issues/609))
- The Moonshot preset finds the host that answers for the key: "fetch models from the endpoint" probes both Moonshot hosts and writes the one that listed models back into the base URL (issue [#598](https://cnb.cool/shinytale/nanopi/-/issues/598))

### Fixed

- Tabs run turns in parallel: the server held one process-wide turn flag, so a turn in one tab was refused while another tab was busy, and "stop" aborted whatever was running. The sidebar marks running sessions and offers "stop all", and a 409 names the other run instead of dropping the prompt (issue [#601](https://cnb.cool/shinytale/nanopi/-/issues/601))
- A questionnaire raised by a background turn reaches the page: the request is listed by `/chat/active` beside the turns, so a reloaded tab renders the card too instead of waiting for a stream it never had (issue [#609](https://cnb.cool/shinytale/nanopi/-/issues/609))

## [20261107]

### Fixed

- The mobile shell has 44px touch targets throughout: the sidebar's secondary actions and the model picker were smaller than a fingertip, and the hover styling that only makes sense with a pointer no longer sticks to the last tapped row. The composer also keeps its place when the soft keyboard opens instead of scrolling the conversation out from under the input
- Opening a file or the terminal on a phone has a way back to the conversation: the mobile bar carries a back arrow to the chat, the drawer moved to its end, the terminal gained the close button the desktop layout already had, and selecting or creating a session closes the panel
