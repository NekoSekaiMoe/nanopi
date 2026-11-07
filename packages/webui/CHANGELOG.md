# Changelog

## [Unreleased]

## [20261107]

### Fixed

- The mobile shell has 44px touch targets throughout: the sidebar's secondary actions and the model picker were smaller than a fingertip, and the hover styling that only makes sense with a pointer no longer sticks to the last tapped row. The composer also keeps its place when the soft keyboard opens instead of scrolling the conversation out from under the input
- Opening a file or the terminal on a phone has a way back to the conversation: the mobile bar carries a back arrow to the chat, the drawer moved to its end, the terminal gained the close button the desktop layout already had, and selecting or creating a session closes the panel
