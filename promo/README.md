# Promo Reel — סל חכם

A short vertical video (Reel / Story / Shorts) in Hebrew that shows the idea and how to use the extension.

| File | What it is |
|---|---|
| `sal-hacham-reel.mp4` | The video: H.264 MP4, 1080×1920, 30 fps, about 39 s. **No audio** |
| `reel-poster.png` | Cover / poster frame (1080×1920) |
| `reel.html` | Source of the animation (one `<canvas>`). Open it in Chrome for a looping preview, or add `?t=12.5` to freeze at a given time |
| `shots/` | Screenshots of the real extension UI, plus `meta.js` (element positions used for the highlights) |
| `frames/` | Frames taken from the finished MP4 so you can check it without playing it |

## Regenerate

```bash
PLAYWRIGHT_BROWSERS_PATH="$USERPROFILE/.sal-pw-browsers" node tools/make-reel.mjs
#   --skip-shots   reuse the screenshots in promo/shots/
#   --no-record    skip the MP4; render the poster and frames straight from the canvas
```

The script:

1. Loads the real extension in Chromium against the e2e mock sites (`tests/e2e/harness.mjs`) and runs
   settings → list → review → fill → result. It takes the screenshots along the way.
2. Records `reel.html` in real time with `MediaRecorder` (`video/mp4;codecs=avc1`).
3. Writes the poster and decodes the verification frames from the MP4.

## Notes

- **No sound.** No licensed music or voice-over was available. Add a track in the app you post from
  (Instagram, TikTok and YouTube all have built-in music libraries), or overlay one in any video editor.
- **The data is made up.** The products, prices and delivery fees come from the test mock sites
  (`tests/e2e/mocks`). The video contains no personal data, account or address.
- **The "site cart" card in scene 7 is a drawing,** not a screenshot of the real site. It lists the products
  chosen for that site on the review screen.
- **Leave room for the app's controls.** Captions sit between y≈260 and y≈1520, so they stay clear of the
  Reels UI at the top (~220 px) and bottom (~380 px).
- **Fonts.** The text uses Segoe UI, a system font on Windows. Text weights are capped at 700 because
  heavier weights fall back to a different Hebrew typeface. If you render on another OS, check
  `frames/` for font changes.

## Storyboard (≈39 s)

1. Hook: logo, then "שופרסל, רמי לוי או חצי חינם? איפה הסל שלך הכי זול?"
2. "להשוות ידנית? שעה של עבודה."
3. "סל חכם — כותבים את הרשימה פעם אחת" (list screenshot)
4. "התוסף ממלא עגלה אמיתית בכל אחד משלושת האתרים" (three carts fill up)
5. "בודקים מה נבחר, מחליפים, או ״לא לקנות כאן״" (review screenshot: product picker and the exclude checkbox)
6. "רואים מחיר אמיתי מהאתרים, כולל משלוח — והמשתלם מסומן" (result screenshot with the winner highlighted)
7. "עבור לעגלה — ומשלמים באתר כרגיל."
8. "התוסף לא משלם · לא רואה פרטי אשראי · עובד רק בשלושת האתרים · הנתונים נשארים אצלך"
9. CTA: logo, "חינם · קוד פתוח", github.com/Marku-a/Claude-Market-online, "מדריך התקנה בעברית ב-README"
