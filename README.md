# Roll Together
Roll Together is a browser extension for Google Chrome and Mozilla Firefox. It synchronizes Crunchyroll Videos that are being played at multiple computers.

## Retirement note
I believe this extension's purpose was completed as we went through the pandemic and were able to still feel close our friends, at least while we watched anime. Since then, several other forks and new extensions with similar purposes were created. Finally, the maintainance cost, as an totally free open source project, increased with manifest v3, changes in the crunchyroll player and pushbacks from Google to publish fixes.

I want to leave a huge thanks to everyone who contributed to this project.

## Sync improvements in this fork
- **No more echo / ping-pong**: the content script keeps its own picture of the room and only
  sends a player change when it really differs from it. Changes applied after a remote update
  are never sent back. Jumps (like "Skip intro") are detected with the `seeking` event.
- **Skipping the opening**: friends load the jump in parallel; whoever finishes loading last
  tells the room where they really are, so the others wait instead of staying seconds apart.
  A light drift correction keeps everybody within about a second.
- **Joining**: the room state is applied once the Crunchyroll player has loaded (it used to be
  overwritten by Crunchyroll's own "continue watching" position). When the browser blocks
  autoplay, a "join playback" button appears: one click instead of spamming the space bar.
  Tip for Firefox: allow autoplay for crunchyroll.com (padlock in the address bar → Autoplay).
- **Late joiners and reconnections**: the server resets the room to "paused" at its last stored
  position whenever someone (re)connects; members now ignore that reset and re-send the real
  state, so nobody gets paused and rewound. A dropped connection rejoins the same room.
- **Robustness**: only the frame that holds the player talks to the background script, a page
  reload (F5) brings the tab back in sync, disconnecting stops the sync on the page, and the
  Firefox background page is persistent.

The sync logic lives in `src/sync.ts` and is checked by a simulation of several friends with
different connections (`npm run test:sync`).

## Browser Support
- **Chrome/Chromium**: Manifest V3 (Chrome 116+)
- **Firefox**: Manifest V2 (Firefox 109+)

## Download
- **Chrome**: [Chrome Web Store](https://chrome.google.com/webstore/detail/ilpfeljgdikoabaclkjgkbeegeoijfca)
- **Firefox**: Available as a signed add-on (coming soon)

## Development Setup

### Prerequisites
- Node.js and npm
- Git

### Building the Extension

#### For Chrome (Manifest V3):
```bash
npm install
npm run build:chrome
# Output will be in the 'build' directory
```

#### For Firefox (Manifest V2):
```bash
npm install
npm run build:firefox
# Output will be in the 'build-firefox' directory
```

#### For both browsers:
```bash
npm run build:production:chrome
npm run build:production:firefox
npm run package
# Creates rolltogether-chrome.zip and rolltogether-firefox.zip
```

### Development Mode
```bash
# Watch mode for Chrome
npm run watch:chrome

# Watch mode for Firefox
npm run watch:firefox
```

## Installation from Source

### Chrome/Chromium
1. Open the Extension Management page by navigating to chrome://extensions.
2. Enable Developer Mode by clicking the toggle switch next to Developer mode.
3. Click the LOAD UNPACKED button and select the `build` directory.

### Firefox
1. Navigate to about:debugging
2. Click "This Firefox"
3. Click "Load Temporary Add-on"
4. Select any file in the `build-firefox` directory

![](https://developer.chrome.com/static/images/get_started/load_extension.png)

## TODO
- [x] Customizable Palette
- [x] Improve Logo/Name
- [x] Improve structure to allow more than one tab at the same time
- [x] Firefox Browser Support
- [ ] Work with autoplay
- [ ] Create a Website

## Related Repos
Backend repo: https://github.com/samuraiexx/roll_together_backend
