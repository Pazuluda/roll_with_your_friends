# Texts for the addons.mozilla.org page

Copy these into the Developer Hub ("Modifier la page du produit").

## Name
Roll With Your Friends

## URL (slug)
roll-with-your-friends

## Summary (250 characters max)
Watch Crunchyroll with your friends, each at home, perfectly in sync: play, pause, skipping the opening and going back are shared with everyone in the room.

## Description
Roll With Your Friends lets you watch Crunchyroll together with your friends, each on your own computer and your own account, perfectly in sync.

**How it works**
1. Open an episode on Crunchyroll.
2. Click the extension's icon, then "Create Room" and "Copy URL".
3. Send the link to your friends. When they open it, everyone is in sync.

Play, pause, "Skip intro" and jumps in the timeline are shared with everyone in the room.

**Highlights**
- Works with Crunchyroll's current player: jumps go through Crunchyroll's own player, so nobody's video freezes.
- Small gaps are smoothed out by playing slightly faster or waiting a moment, instead of jumping.
- Joining a room while the others are already watching puts you at their position.
- If Firefox blocks autoplay, a button lets you join the playback in one click. Tip: allow autoplay for crunchyroll.com (padlock in the address bar → Autoplay).
- No account, no ads, no analytics.

**Good to know**
- Everyone needs their own Crunchyroll account (and Premium for Premium episodes). No video is shared, only the playback state.
- Everyone in the room needs this extension.

This is a maintained fork of Roll Together by Mateus de Castro (MIT license). Not affiliated with Crunchyroll.

Source code: https://github.com/Pazuluda/roll_with_your_friends

## Categories
- Social & Communication
- Photos, Music & Videos (optional second category)

## Tags
crunchyroll, anime, watch party, sync, friends

## Homepage
https://github.com/Pazuluda/roll_with_your_friends

## Support site
https://github.com/Pazuluda/roll_with_your_friends/issues

## License
MIT License

## Privacy policy
Paste the contents of PRIVACY.md (English part), or link to
https://github.com/Pazuluda/roll_with_your_friends/blob/main/PRIVACY.md

## Notes to reviewer (when submitting the version)
Build: Node.js 18+ and npm. Run `npm install` then `npm run build:production:firefox`; the
extension is generated in `build-firefox/`. Third-party libraries from npm: lodash 4.17.21 and
socket.io-client 4.7.5.

To control Crunchyroll's player, the content script reads the page's player object through
`wrappedJSObject` (src/crunchyroll_driver.ts) and only calls its `seek()` method; play and pause
use the HTML video element. No remote code is loaded or executed.

Testing needs a Crunchyroll account; free episodes work. Open an episode, click the icon →
Create Room → Copy URL, then open the URL in a second Firefox profile.
