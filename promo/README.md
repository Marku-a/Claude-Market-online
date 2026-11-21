# Promo Reel — סל חכם

A short vertical video (Reel / Story / Shorts) in Hebrew that shows the idea and how to use the extension.

| File | What it is |
|---|---|
| `sal-hacham-reel.mp4` | The video: H.264 + AAC MP4, 1080×1920, 30 fps, about 45 s, with a Hebrew voice-over and background music |
| `reel-poster.png` | Cover / poster frame (1080×1920) |
| `reel.html` | Source of the animation (one `<canvas>`). Open it in Chrome for a looping (silent) preview, or add `?t=12.5` to freeze at a given time |
| `reel-audio.js` | Sound: decodes and measures the voice clips, composes the music, measures the finished MP4 |
| `voiceover.he.txt` | The voice-over script, one line per scene (`<scene id>: <text>`) |
| `audio/` | `vo-01.mp3` … `vo-09.mp3` (voice clips), `music.wav` (the music on its own), `manifest.json` (which text each clip was made from), `timing.js` (scene durations fitted to the voice) |
| `shots/` | Screenshots of the real extension UI, plus `meta.js` (element positions used for the highlights) |
| `frames/` | Frames taken from the finished MP4 so you can check it without playing it |

## Regenerate

```bash
PLAYWRIGHT_BROWSERS_PATH="$USERPROFILE/.sal-pw-browsers" node tools/make-reel.mjs
#   --skip-shots                reuse the screenshots in promo/shots/
#   --no-record                 skip the MP4; render the poster and frames straight from the canvas
#   --voice=he-IL-AvriNeural    male voice (default: he-IL-HilaNeural, female)
#   --rate=+8%                  speaking rate passed to the TTS (default +8%)
```

Needs Python with `edge-tts` (`python -m edge_tts`; set `PYTHON=...` if `python` is not the right one) and an
internet connection the first time a line is spoken.

The script:

1. Loads the real extension in Chromium against the e2e mock sites (`tests/e2e/harness.mjs`) and runs
   settings → list → review → fill → result. It takes the screenshots along the way.
2. Voice-over: sends each line of `voiceover.he.txt` to Microsoft's online neural TTS (`edge-tts`) and saves
   `audio/vo-XX.mp3`. Only the script text is sent. A line is sent again only when its text, the voice or the
   rate changed (`audio/manifest.json`).
3. Decodes the clips in Chromium (WebAudio), measures where the speech starts and ends, and makes each scene
   long enough for its clip (voice starts 0.25 s into the scene, 0.5 s in the first one; at least 0.3 s of
   quiet before the cut). Scenes never get shorter than the animation needs. The durations go to
   `reel.html` (`REEL.setTiming`) and to `audio/timing.js`.
4. Composes the music for exactly that length and saves `audio/music.wav`.
5. Records `reel.html` in real time with `MediaRecorder` (`video/mp4;codecs=avc1,mp4a.40.2`): canvas frames plus
   the audio mixed in an `AudioContext`. The animation runs on the `AudioContext` clock, so picture and sound
   stay together. If the encoder dropped frames (it sometimes does, near the start), it records again.
6. Writes the poster and decodes the verification frames from the MP4, then measures the MP4's sound: peak,
   loudness per second, where each voice clip really starts compared with where the picture's scene starts,
   and the music level between clips.

## Notes

- **Voice.** Microsoft's neural Hebrew voice `he-IL-HilaNeural` (female) via `edge-tts`. To switch to the male
  voice run with `--voice=he-IL-AvriNeural`; to change the words edit `voiceover.he.txt`. The script has no
  niqqud, so listen once after a change: the TTS may stress or read a word differently than intended.
- **Music is original.** It is composed by code in `reel-audio.js` (WebAudio `OfflineAudioContext`: soft drums,
  bass, chord pads and plucks, D major, 116 BPM, I–V–vi–IV, fade-in and a final chord at the end). No samples or
  third-party music, so there is nothing to license. The music dips by 11 dB while the voice speaks
  (150 ms ramps). Levels: voice peaks about −3 dBFS, music peaks about −9 dBFS between clips and about −20 dBFS
  under the voice, a safety limiter at −1.5 dBFS.
- **Want different music?** The voice clips are in `audio/vo-XX.mp3` and `audio/timing.js` lists when each one
  starts (`clips[].on`, seconds), so a video editor can rebuild a voice-only track under other music.
- **The data is made up.** The products, prices and delivery fees come from the test mock sites
  (`tests/e2e/mocks`). The video contains no personal data, account or address.
- **The "site cart" card in scene 7 is a drawing,** not a screenshot of the real site. It lists the products
  chosen for that site on the review screen.
- **Leave room for the app's controls.** Captions sit between y≈260 and y≈1520, so they stay clear of the
  Reels UI at the top (~220 px) and bottom (~380 px).
- **Fonts.** The text uses Segoe UI, a system font on Windows. Text weights are capped at 700 because
  heavier weights fall back to a different Hebrew typeface. If you render on another OS, check
  `frames/` for font changes.

## Storyboard (≈45 s; scene lengths follow the voice-over, see `audio/timing.js`)

1. Hook: logo, then "שופרסל, רמי לוי או חצי חינם? איפה הסל שלך הכי זול?"
2. "להשוות ידנית? שעה של עבודה."
3. "סל חכם — כותבים את הרשימה פעם אחת" (list screenshot)
4. "התוסף ממלא עגלה אמיתית בכל אחד משלושת האתרים" (three carts fill up)
5. "בודקים מה נבחר, מחליפים, או ״לא לקנות כאן״" (review screenshot: product picker and the exclude checkbox)
6. "רואים מחיר אמיתי מהאתרים, כולל משלוח — והמשתלם מסומן" (result screenshot with the winner highlighted)
7. "עבור לעגלה — ומשלמים באתר כרגיל."
8. "התוסף לא משלם · לא רואה פרטי אשראי · עובד רק בשלושת האתרים · הנתונים נשארים אצלך"
9. CTA: logo, "חינם · קוד פתוח", github.com/Marku-a/Claude-Market-online, "מדריך התקנה בעברית ב-README"
