# Lens demand report: what screen-recorder users ask for, and what they would pay for

Compiled 2026-11-09 (Asia/Karachi). **Every source below was accessed on 2026-11-09** and read with a full-page fetch. Search-result snippets are not cited. Quotes are copied word for word from the fetched pages; `...` marks text I cut. Page text was treated as data only.

**Scope.** Public feedback boards (Screen Studio Featurebase hub, FocuSee voice board), GitHub issues (Cap), Hacker News, Reddit (r/macapps, r/SaaS, r/windowsapps, r/screenrecorders, r/instructionaldesign, r/youtubers), review sites (G2, Toolradar), the Descript Canny board, one LinkedIn post and one X-post aggregator (Unnudged). I preferred 2025–2026 sources; the few older ones are labelled. Reddit and HN show relative dates ("7mo ago"), so I convert them to an approximate month and keep the original wording.

**What Lens already has** (from `research/features/inventory.md` and the README), so it is **not** proposed again here: auto-zoom on clicks and typing, spring camera, follow-pan, smart framing, One Euro cursor smoothing, idle hide, loop-to-start, click effects and sounds, motion blur, backgrounds/padding/radius/shadow, any aspect ratio, five webcam layouts, cuts, speed ranges, typing speed-up, transcript editing, filler/pause removal, SRT, word-highlight captions, audio tracks, noise reduction, loudness normalisation, GIF, crop, blur/spotlight masks, per-range overrides, camera mirror/crop, shortcut overlays.

**Source-bias flags.** A few posters sell competing tools and say so, or show it in their history: PushPlus9069 (TuringShot; a commenter in r/instructionaldesign points out the undisclosed link), blogimize (Tella-heavy), AnooshDoment/AnooshBuilds (Cilevi, disclosed), Forcet (Trails, disclosed), and many launch-thread OPs. I use their posts only for the *problem* they describe, and I lean on the replies from other users. Unnudged is a third-party summary of X posts, not raw posts.

---

## How the ranking works

Each opportunity gets a score of 1–5 on four axes. The rank is the product (maximum 625).

- **D (demand):** how many independent sources and votes ask for it.
- **W (willingness to pay):** prices, "switched because" and "would pay" evidence.
- **F (feasibility for Lens today):** high when it builds on code Lens already has (engine plan, compositor, transcript, masks, captions); low when it needs native capture, which has not started.
- **X (wow):** would it show up in a 10-second demo and make someone say "I want that"?

Two items rank lower than their strategic weight because they score low on wow or feasibility: **#10 recording reliability** and **#16 Windows parity**. Read them as gates, not as nice-to-haves. The evidence says users leave paid tools over these two things.

### Ranked list

| # | Opportunity | D | W | F | X | Score | Size |
|---|---|---|---|---|---|---|---|
| 1 | Multi-take recording with automatic best-take assembly | 5 | 4 | 4 | 4 | 320 | M |
| 2 | Calm, controllable auto-zoom (zoom budget, intensity, comfort mode) | 5 | 3 | 5 | 4 | 300 | S–M |
| 3 | Automatic privacy redaction (emails, tokens, keys, notifications) | 4 | 4 | 4 | 4 | 256 | M |
| 4 | Text, arrows, callouts and auto step labels, all non-destructive | 5 | 4 | 4 | 3 | 240 | M |
| 5 | Demo-as-code: re-render the video when the UI changes | 4 | 4 | 3 | 5 | 240 | L |
| 6 | Agent/MCP/CLI control of recording and edits | 3 | 3 | 5 | 5 | 225 | M |
| 7 | One recording → video + clickable interactive demo + step guide | 3 | 5 | 3 | 5 | 225 | L |
| 8 | On-device caption translation and multi-language export | 3 | 4 | 4 | 4 | 192 | M |
| 9 | Projects, presets and brand kit (save, reopen, reuse a look) | 4 | 4 | 5 | 2 | 160 | S–M |
| 10 | Never lose a take: crash-safe autosave, drift-free long recordings, salvage | 5 | 5 | 3 | 2 | 150 | M–L |
| 11 | Pro hand-off: cursor as alpha layer, ProRes 4444, NLE project export | 3 | 4 | 4 | 3 | 144 | M |
| 12 | Cursor that matches the UI (no hover states firing before the cursor arrives) | 3 | 3 | 4 | 4 | 144 | M |
| 13 | Instant share link from a local-first app (bring your own storage) | 4 | 4 | 3 | 3 | 144 | M–L |
| 14 | Transitions plus enter/exit animations for every element | 4 | 3 | 4 | 3 | 144 | M |
| 15 | One recording → 16:9 + 9:16 + 1:1 cuts with re-aimed zooms | 3 | 3 | 5 | 3 | 135 | S–M |
| 16 | Windows as a first-class platform | 5 | 4 | 2 | 3 | 120 | L |
| 17 | Narration after the fact: record or replace voiceover per line, import audio | 5 | 3 | 4 | 2 | 120 | S–M |
| 18 | Camera scenes: camera-only cuts, hide-when-silent, move/resize in post | 3 | 3 | 4 | 3 | 108 | S–M |
| 19 | Hotkey zoom markers and "don't zoom" modifier while recording | 4 | 3 | 3 | 3 | 108 | M |
| 20 | Freeze frame, still images and full-screen title cards | 3 | 3 | 5 | 2 | 90 | S |
| 21 | Light on the machine: background render, bounded RAM, no demo lag | 4 | 3 | 3 | 2 | 72 | M |
| 22 | Crisp small text in zooms (super-resolution, capture headroom) | 2 | 3 | 3 | 4 | 72 | M–L |
| 23 | Music bed with automatic ducking under speech | 3 | 2 | 5 | 2 | 60 | S |
| 24 | Platform export presets (App Store preview, YouTube, LinkedIn, X) | 2 | 3 | 5 | 2 | 60 | S |
| 25 | Pre-flight check: mic/system-audio test, live meters, notification mute | 3 | 3 | 3 | 2 | 54 | S |
| 26 | Several windows as separate layers, rearranged in post | 2 | 3 | 2 | 4 | 48 | L |
| 27 | AI title, description and chapters from the transcript | 2 | 2 | 5 | 2 | 40 | S |
| 28 | Multiple audio inputs (Loopback/BlackHole-style routing) | 2 | 3 | 3 | 1 | 18 | M |
| 29 | Linux build | 2 | 2 | 2 | 2 | 16 | L |

Pricing and business-model findings are in their own section after #29.

---

## 1. Multi-take recording with automatic best-take assembly — 320 · M

**The problem in users' words**
- "Lately I've been just starting the recording from scratch every time I mess up, but it's so exhausting and time consuming." — r/youtubers, ≈Apr 2025 ("2y ago") https://www.reddit.com/r/youtubers/comments/1k643g6/how_do_you_all_deal_with_messing_up_during
- FocuSee request "More recordings on timeline" (216 votes): "If you misspeak you have to start new projects over and over again?" — https://focusee-voice.imobie.com/?sortBy=upvotes%3Adesc
- "these recording editors don't have arrows and callouts, not even a freeze frame. I have to plan the recording to the letter and after 10 frustrating takes..." — alin23, HN, ≈Apr 2026 https://news.ycombinator.com/item?id=47595695
- "Sometimes steps get skipped over ... difficult or impossible to recreate just those steps without having the redo the entire thing." — Supademo G2 reviewer, 9/28/2026 https://www.g2.com/products/supademo/reviews
- A text-editing habit users describe: "jump cuts, text based editing and giving myself cues like add this to this section or use the last take" — jessi-poo, r/youtubers (link above)

**How often:** This has the most votes of any request. Screen Studio hub: "Import clips / append" 535 (planned), "multi-clip recordings" 468; FocuSee: 216. It also appears in HN, Reddit and G2 threads.

**Willingness to pay:** Notch (Windows/Mac, $49 commercial licence at launch) lists "Multi-segment recording: stop, edit, continue, export as one clip" as a headline feature (https://www.reddit.com/r/windowsapps/comments/1tp8tlx/i_got_tired_of_maconly_screen_recorders_so_i/). Screen Studio has marked append as planned but not shipped. Users already pay $29/mo for Screen Studio without it.

**Competitors:** Screen Studio: planned, not shipped. FocuSee: not done. Notch: append segments only. Nobody picks the best take for you.

**Proposed Lens feature: "Takes."** Add a *Record another take* button that appends to the same project. Then use the transcript Lens already makes to find repeated sentences (the same text said 2–3 times in a row). Keep the **last complete** version, fold the others into a collapsed "alt takes" lane, and let the user swap a take with one click. Cut on the pause before each sentence so the cursor and zoom state stay continuous; snap the cursor across the cut with the existing loop-to-start smoothing.

**Build size:** M. It needs project save (#9) and a transcript-alignment pass; the cut, speed and pause logic already exists.

**Status (2026-11-09): built, first version.** Retake detection from the transcript, keep last / best take, reversible take cuts, Alt takes lane with one-click swap, A/B preview and undo, `edits.takes` (see `docs/Takes.md`). Measured on a held-out test set: word precision 0.957, recall 1.000; group precision 0.933, recall 1.000 (target ≥90% met). Pipeline on synthetic speech: re-transcribed export WER 9.5% vs the clean script. Not done: the *Record another take* button (needs native capture), real-voice testing, the hallway test.

**How to test:** Run `research/harness/synth_session.py` to script a session that says each sentence 1–3 times with fumbles. Measure precision/recall of "kept the intended take" against ground truth (target ≥90%). In a 5-person hallway test, compare time to a clean cut against manual transcript editing.

---

## 2. Calm, controllable auto-zoom — 300 · S–M

**The problem in users' words**
- "the automatic zoom style gives me motion sickness. This is not specific only to ShotGlass. It has become common in screen recording apps, and a lot of these demos are hard for me to watch now." ... "control how often zooms are added, how strong they are, how fast the animation is, or how sensitive the trigger is" — haystack_in_needle, r/macapps, ≈May 2026 https://www.reddit.com/r/macapps/comments/1tcrf24/i_made_a_screen_recorder_that_makes_your_demos/
- "I feel like it's almost constantly zooming in and out. I feel similarly with videos people make with screen studio. I think you have an opportunity here to improve on the status quo" — -json-, r/macapps, ≈Mar 2026 https://www.reddit.com/r/macapps/comments/1rsf44t/os_i_made_a_free_opensource_screen_studio/
- "the auto tracking while zooming in on the cursor - that's a bit disorienting ... separate zoom in's position from the cursor" — barefut_, same thread
- "ScreenStudio / FocuSee - they auto-zoom on every mouse click ... zooms when you're just clicking around the UI ... you end up fixing it all in post anyway" — r/instructionaldesign, ≈Mar 2026 (OP has a tool link) https://www.reddit.com/r/instructionaldesign/comments/1rq88sp/screen_recording_workflow_for_software_training
- "it might overdo it and you find yourself zooming in and out when it's absolutely unnecessary" — WeekendBorn7885, same thread
- "constant panning/zooming to be very distracting and almost dizzying" (IshKebab) and "Looks smooth, but holy motion sickness." (Nexxxeh) — HN https://news.ycombinator.com/item?id=47595695
- Screen Studio hub "Advanced auto-zoom adjustments": "too aggressive with how much it follows the mouse ... Zoom range Follow delay & speed" — https://hub.screen.studio/?b=6376af1f65cdfb454db68d01

**How often:** At least 8 independent complaints across 4 communities. It shows up in nearly every launch thread for an auto-zoom tool.

**Willingness to pay:** Indirect. This is a reason people **don't** adopt the category ("hard for me to watch"), and the r/instructionaldesign OP spends post time undoing zooms ("That alone could take an hour per video"). A calmer default is a reason to pick Lens over Screen Studio.

**Competitors:** Screen Studio has Focused/Smooth plus a zoom-level slider. FocuSee has 4 speeds plus tension/friction/mass (inventory ZM-08). Neither has a **zoom budget** or a motion-comfort setting. Screen Studio users edit `project.json` by hand just to remove every zoom (hub post "remove all zooms").

**Proposed Lens feature: "Calm camera."**
1. A *zoom budget* (maximum zooms per minute, minimum hold time, merge nearby clicks into one framing). The planner keeps only the highest-value zoom events.
2. An *intensity* control with 3 presets (Calm / Default / Punchy) that drive spring stiffness, maximum scale and pan speed, which fills the inventory gap "no zoom speed presets".
3. *Comfort mode*: caps angular and scale velocity, no follow-pan while zoomed (fixed framing), and no motion blur on the camera.
4. Bulk actions: "remove all zooms" and "apply to all".

**Build size:** S–M. All of it is planner parameters on the existing spring camera.

**How to test:** Run `research/harness/blind_ab.py` with Default vs Calm on the same 3 sessions. Viewers rate comfort and clarity (1–5) and pick one. Also measure camera velocity and zooms per minute with `measure.py`. Ship if Calm wins comfort without losing "could follow the steps".

---

## 3. Automatic privacy redaction — 256 · M

**The problem in users' words**
- "Screen recorder, then a clean browser profile so your bookmarks and notifications don't end up on camera, then a take where you don't fumble a single click" — r/SaaS, ≈Aug 2026 https://www.reddit.com/r/SaaS/comments/1vg7ukk/our_tutorial_videos_broke_after_a_redesign_so_i
- "blur any private tokens/URLs before export" — AnooshBuilds (vendor, disclosed), r/instructionaldesign (link in #2)
- Screen Studio hub "Multiple mask layers" (155 votes) asks for masks that can "fade in ... see through for a short, but compromising, period" — https://hub.screen.studio/?sortBy=upvotes%3Adesc
- Cap open issue #143 asks for a picker to blur sensitive fields (top issues list on https://github.com/CapSoftware/Cap/issues)

**How often:** Screen Studio's manual masking request reached 569 votes before it shipped. That shows the size of the need; the *automatic* version is what is still missing. Plus 155 votes for multiple masks, a Cap issue and 2 Reddit mentions.

**Willingness to pay:** Teams pay for this in demo platforms: Arcade lists "Blurring for sensitive information" and Supademo lists "Blurs and redactions" as paid-tier features (https://toolradar.com/tools/arcade, https://www.g2.com/products/supademo/reviews).

**Competitors:** Screen Studio and FocuSee: manual masks only (inventory). Lens already has masks; the gap is **auto-hide sensitive data**.

**Proposed Lens feature: "Auto-redact."** Run OCR on keyframes, on-device. Detect emails, API-key/JWT/token patterns, credit-card-like numbers, phone numbers and user-supplied words (customer names). Create blur masks that track the text across frames. Show a review list ("12 items found") before export. Optional: detect and blur OS notification banners.

**Build size:** M. Lens has the mask renderer; it needs OCR (Apple Vision or Tesseract), regex rules and simple box tracking.

**How to test:** Build a synthetic corpus with planted secrets (20 recordings, 200 secrets). Measure recall (target ≥98%) and false positives per minute. Track one funnel metric: the share of exports that run the review step.

**Status (2026-11-09): built, first version.** On-device OCR (Tesseract) + classifiers for emails, phones, Luhn-valid cards, API keys, JWTs, high-entropy tokens, IPs and corner notification banners; boxes tracked frame by frame through scrolls, moving cards and partial cover; review list with thumbnails, accept / dismiss one or all, blur / pixelate, undo; accepted items are tracked masks that follow zooms; export warns while items are pending (see `docs/Privacy.md`). Measured on a synthetic session written after tuning (60 s, 13 planted items): instance recall 1.000, frame recall 0.991, 0 false positives per minute; rendered export with all items accepted: 0 of 6041 secret regions readable by OCR. Smaller than the proposed corpus (3 sessions, 38 planted items, not 20 recordings / 200 secrets). Not done: user-supplied words (customer names), real-app recordings, the review-step funnel metric.

---

## 4. Text, arrows, callouts and auto step labels, non-destructive — 240 · M

**The problem in users' words**
- "these recording editors don't have arrows and callouts, not even a freeze frame" — alin23, HN (link in #1)
- "adding text can help with correcting errors in speech. Captions does not really cover it" — marias_martin on X, as quoted by https://unnudged.com/catalog/screen-studio
- "record multiple clips, overlay/combine them together like what you can do with CleanShotX, add annotations, and export as GIF ... I'm juggling multiple tools just to layer recordings and add callouts." — RoosterOnCommand, r/macapps, ≈Apr 2026 https://www.reddit.com/r/macapps/comments/1sfufi6/im_tired_of_monthly_subscriptions_for_screen
- "I'm against having any software doing automatic zooms and annotations unless it can keep the original recording untouched just in case I need to make changes later." — VeLearning, r/instructionaldesign (link in #2)

**How often:** Screen Studio hub: annotation tools 249, click descriptions 223, full-text slides 482, enter/exit animations 312. FocuSee annotations (302) is already shipped. HN, X and Reddit mentions on top.

**Willingness to pay:** Camtasia keeps instructional designers paying a yearly fee partly for callouts ("features that call attention to your cursor and clicks", r/instructionaldesign). FocuSee shipped it as a top paid-plan feature.

**Competitors:** FocuSee: done. Screen Studio: missing (only captions). Lens: missing (inventory gap "no text, shapes or watermark").

**Proposed Lens feature: "Callouts."** Text, arrow, box/highlight and number badges as timeline items that stay anchored to screen coordinates, so they follow zoom and pan. **Auto step labels**: on each click, read the clicked control's accessibility label (or OCR text near the click) and offer a draft label such as "Click **Save**". Never bake overlays into the source footage; they stay editable until export.

**Build size:** M. It is a compositor layer, an anchor transform and a label generator.

**Status (2026-11-09): built, first version.** Text (title, lower-third, label), arrows (straight or curved, head styles), box / ellipse highlights, numbered step badges and callout bubbles with in / out animations (fade, spring pop, draw-on, typewriter), anchored to the screen (they follow zoom and pan) or to the frame; full-frame text slides between segments with their own duration; all non-destructive project data. Auto step labels: clicks + on-device OCR around each click draft "Click Save" / "Open Settings", reviewed and edited before they become badges numbered 1, 2, 3 (see `docs/Annotations.md`). Measured: step labels 16/16 exact on a held-out synthetic session (14/14 on the dev one), numbering 100% in click order; preview ↔ export SSIM mean 0.990 / min 0.983 on annotation frames; screen-anchored box within 1.7 px of its target through a 2× zoom; text read back by OCR from the export 14/14 words. Not done: the 5-user task test, the 100-click / 5-real-app label test, accessibility-tree labels (needs native capture), magnifier and watermark.

**How to test:** Task test: 5 users add 6 callouts to a 2-minute demo; measure time against Camtasia or Keynote. Check auto-label accuracy on 100 clicks across 5 web apps (target ≥80% usable unedited).

---

## 5. Demo-as-code: re-render the video when the UI changes — 240 · L

**The problem in users' words**
- "A redesign shipped, and most of them were suddenly wrong ... Seven videos took a day. Two months later, another day. So we stopped, and honestly I think that's what most teams do without ever admitting it." — r/SaaS, ≈Aug 2026 https://www.reddit.com/r/SaaS/comments/1vg7ukk/our_tutorial_videos_broke_after_a_redesign_so_i
- Same author on the quality bar: "My first version used the recorder built into Playwright ... 25 frames per second, and on longer videos it quietly drops frames, so the cursor stutters right where it should glide."
- "30-minute walkthroughs are hard to maintain because every UI update means re-recording" — WillingJello4512, r/instructionaldesign (link in #2)
- "the second a workflow starts to change, the video becomes outdated" — Forcet (vendor, disclosed), same thread
- "recording is really not the issue more the automation. Like that he opens a tab and scrolls, and then switches language." — App-Ads, r/macapps, ≈Apr 2026 https://www.reddit.com/r/macapps/comments/1s6wbxr/what_tool_do_you_use_for_screen_recording_ios/
- Toolradar's summary of Arcade's G2 reviews: "Editing existing demos is a recurring complaint ... requiring individual step deletions and fiddly cropping when a product UI changes." — https://toolradar.com/tools/arcade

**How often:** 5+ independent sources. A builder shipped an MIT tool for it (silky-recorder), and it is a selling point for Arcade ("Demos are live assets").

**Willingness to pay:** Strong for teams. Arcade's former Growth plan cost "a flat 297.50 dollars per month for 5 seats" (Toolradar). Supademo charges $27–38 per user per month (G2). The r/SaaS team stopped making videos altogether rather than pay the re-record cost.

**Competitors:** Screen Studio and FocuSee: none. Interactive-demo tools re-capture HTML but don't make polished video. The open-source silky-recorder is terminal-only, with "no editing step".

**Proposed Lens feature: "Script mode."** Write a step file (YAML/JSON: open URL, click selector, type, wait, caption, zoom hint) and run it in a headless browser that Lens drives. Capture frames with exact timestamps at 60 fps, emit synthetic cursor and click events into the existing engine, and render with the same look and presets. Running it again regenerates the video, and it can run in CI on every release. Bonus: a `--locale` flag reruns the script per language (ties to #8).

**Build size:** L. A browser driver and frame capture are new; everything after capture (planner, compositor, captions) is reused.

**How to test:** Use 3 real public web apps and script one 60-second flow each. Change CSS (move a button) and re-run; measure the success rate and the hands-on minutes saved against manual re-recording. Check cursor smoothness on long runs with the harness (no dropped frames).

---

## 6. Agent/MCP/CLI control of recording and edits — 225 · M

**The problem in users' words**
- Screen Studio hub "MCP Please!" (17 votes): "It would be magical if Screen Studio can record via prompts from AMP/remote machine." — https://hub.screen.studio/?b=6376af1f65cdfb454db68d01
- "today automation is still fragile because agents must still: detect the right window/display ... move the mouse to the target ... press Enter to confirm ... Document the supported deeplinks and parameters, or provide a small CLI/API" — Song Yue, Mar 17 2026 https://hub.screen.studio/p/more-automation-and-agent-friendly
- "CLI/MCP records a window → returns a project ID → I say 'redo the zoom at 1:30–2:20' → agent edits..." — belazyAF on X, as quoted by https://unnudged.com/catalog/screen-studio (MCP/CLI/agent is the top "wish" there, 5 posts)
- Cap has an open "CLI api key" issue, #2053 (top issues on https://github.com/CapSoftware/Cap/issues)

**How often:** Low volume but rising fast in 2026: 17 + 5 votes on Screen Studio, 5 X posts, a Cap issue. Tella shipped an MCP integration (mentioned in https://www.reddit.com/r/screenrecorders/comments/1wu0g5q/i_tested_12_screen_recording_software_options_so/).

**Willingness to pay:** The askers are software companies with many releases ("we are constantly releasing new features and have a lot of recording to do"). They build their own wrappers today (screen-studio-skill, Alfred workflow).

**Competitors:** Screen Studio: undocumented deeplinks only. Tella: MCP for editing. Nobody exposes a deterministic edit plan.

**Proposed Lens feature: "Lens MCP."** Lens's engine already has a CLI and a plan model (`packages/engine/src/cli.ts`, `plan.ts`). Expose `record(target)`, `stop() → projectId`, `get_transcript`, `set_zoom(range, params)`, `cut(range)`, `apply_preset`, `export(format)` as an MCP server plus documented CLI flags, and return a machine-readable plan diff for each change.

**Build size:** M. It wraps existing engine commands; the record target needs capture.

**How to test:** A Claude/Cursor agent runs 10 scripted tasks ("cut the intro, tighten pauses, zoom 1:30–2:20 to the sidebar"). Measure task success and edits that need a human fix. Post it in MCP directories and count installs per week.

**Status (2026-11-09): built, first version (no recording).** `lens` CLI and `lens-mcp` MCP server (stdio, `@modelcontextprotocol/sdk`, MIT) over the same operations: project new / open / info, plan, export (mp4 / gif / srt / vtt), `render_frame` (the agent sees a PNG of what it changed), transcribe, translate, takes, privacy scan / review, step labels, presets, brand, JSON-pointer get / set, zoom / cut / annotate; every edit returns a machine-readable diff (JSON-pointer changes to the project) and is idempotent; MCP resources for the project JSON, transcript and preview frame; every path confined to an allowed root (no shell tool). `lens run demo.lens.yaml` replays a declarative edit list so a release pipeline can re-render. Tests: CLI 19 integration (every subcommand happy + error path, exit codes, JSON-shape snapshots), MCP 5 (open → zoom → render_frame changed by 40.6 levels → export 300/300 frames = plan; 14 escape attempts refused), script vs CLI 282/282 identical frames. Not done: `record(target)` / `stop()` (needs native capture), the 10-task agent study, MCP directory listing / install count. See `docs/Automation.md`.

---

## 7. One recording → video + clickable interactive demo + step guide — 225 · L

**The problem in users' words**
- "It solves the problem of our long-form video tutorials being 'black boxes' that users simply don't watch. Since switching to interactive, click-through tours, we've seen engagement skyrocket." — Keisha C., Supademo G2, 5/2026 https://www.g2.com/products/supademo/reviews
- "The price jump to the bigger subscription tier is very substantial and adding additional creators can also start to get expensive ... I wish there was just an editor seat that wasn't an upcharge." — Naomi N., Supademo G2, 10/13/2026 (same page)
- FocuSee request "Interactive guides" (49 votes) mentions Smartcue/Guidejar as "popular in the LTD community" — https://focusee-voice.imobie.com/?sortBy=upvotes%3Adesc
- The Screen Studio hub has a request to auto-generate an SOP from the transcript (title in the hub list, https://hub.screen.studio/?sortBy=upvotes%3Adesc)

**How often:** Moderate (49 FocuSee votes, a Screen Studio request), but there is a whole paid category next to it: Supademo has 663 G2 reviews, Arcade 181.

**Willingness to pay:** Highest of any item. Supademo Pro costs $27/user/mo and Scale $38 (G2). Arcade costs $59/mo flat today and $297.50/mo for 5 seats on the old Growth plan (Toolradar). Users complain about seat prices, so an un-metered local alternative is attractive.

**Competitors:** Screen Studio and FocuSee: video only. Supademo and Arcade: interactive only, with weak video polish ("the interface for editing video-based demos still feels a bit clunky" — Brendon R., G2).

**Proposed Lens feature: "Steps export."** Lens already logs clicks and keystrokes. On export, also emit (a) a self-contained HTML click-through: one still per click, hotspot at the click point, step text from #4 auto-labels, optional per-step video snippets, and (b) a Markdown/PDF step guide. Same blur masks and branding.

**Build size:** L. Click-to-step segmentation, the HTML player and labels are new; stills, masks and labels reuse the compositor.

**Status (2026-11-09): built, first version (stills, no per-step clips, no analytics beacon).** `lens export demo` (CLI, MCP `export_demo`, editor Export dialog) writes one self-contained offline HTML file: one still per accepted step label, drawn by the same compositor as the video (crop, layout, backdrop, privacy masks, watermark), a pulsing hotspot at the click, a tooltip with the step label, next / back / arrow keys / deep links, a progress bar and a call-to-action slide from the project, in the brand's colours, font and logo, responsive down to phone width. `lens export guide` (MCP `export_guide`) writes Markdown, HTML and PDF with a cropped screenshot, a highlight box around the clicked control and the label per step. The editor's Export dialog has format tabs, a live demo preview and a hotspot editor (drag the hotspot, edit the tooltip). Measured: hotspot on the click within 0.13 px (stills, bound 2 px) and 0.16 px in the rendered page at two viewport sizes; 0 secrets readable by OCR in 12 demo / guide images with privacy items accepted (control without masks: 40/41 regions read); the page makes no network request and logs no error offline; guide PDF has the right page and step count and every highlight box. Not done: per-step video snippets, the analytics beacon and the 5-team pilot, branching / multi-path demos, hosting. See `docs/InteractiveDemo.md`.

**How to test:** Fake-door "Export as interactive demo" button in the export dialog; count clicks per export. Then a 5-team pilot comparing time to publish and viewer completion rate (from a tiny analytics beacon in the HTML) against their current tool.

---

## 8. On-device caption translation and multi-language export — 192 · M

**The problem in users' words**
- Screen Studio hub, Mar 6 2026: "Ability to automatically generate and bake-in subtitles ... Support for at least English, or ideally an option to handle both (bilingual support)." — https://hub.screen.studio/p/feature-requests-for-roadmap-instant-cloud-uploadsharing-loom-style-and
- "the range of international accents is still too narrow. For a global company like ours, a wider selection of localized, more human-sounding voice profiles would make our demos feel more aligned" — Keisha C., Supademo G2 (link in #7)
- "Does it support multiple languages? Does it support German?" — gr1nchyy, r/macapps (link in #4)
- "Can I help with the translation into my language?" — HappyHour-24-7, r/windowsapps https://www.reddit.com/r/windowsapps/comments/1tp8tlx/i_got_tired_of_maconly_screen_recorders_so_i/
- iOS localisation automation: App-Ads, r/macapps (quoted in #5)

**How often:** 5 user sources. On the supply side, at least 10 vendors sell demo translation and dubbing (Rask, Perso, Braiv, ScreenDub, VEED, Synthesia and others). That signals a market but is not user evidence, so it is not counted in D.

**Willingness to pay:** Supademo lists one-click translation and AI voiceover as headline paid features (G2 product description). The vendor pages above charge per minute.

**Competitors:** Screen Studio and FocuSee translate nothing (inventory notes neither translates captions). Supademo translates steps.

**Proposed Lens feature: "Languages."** Translate captions on-device (a local MT model), export one SRT/VTT per language and burn-in variants in one batch. Phase 2: an optional local TTS voiceover per language, re-timed with the existing speed ranges. No credits, because it runs locally (see the pricing section on credit anger).

**Build size:** M for subtitles, L for dubbing.

**How to test:** Bilingual raters score translated captions on 10 demos (adequacy 1–5, target ≥4). Pricing fake-door: count how many users tick extra languages at export.

**Status (2026-11-09): subtitles built, first version (dubbing not started).** On-device translation with local CTranslate2 models (Argos Translate / OPUS-MT; MIT / CC0 and CC-BY-4.0, credited in `docs/Translation.md` and the editor's About sheet) into Spanish, French, German, Urdu and Arabic, per caption segment; one caption track per language in the project, re-timed onto the speech so word highlight still works; right-to-left Urdu / Arabic captions shaped and ordered correctly in preview and export; SRT / VTT per language; editor language switcher, Translate to… with progress and side-by-side editing. Measured on 24 fixed UI / tutorial sentences with hand-written references: chrF es 81.2, fr 91.5, de 85.4, ur 50.5; ~160–340 words/s on 2 CPU cores; burned-in Spanish read back by OCR 20/20 words; Urdu / Arabic lines identical to a libraqm whole-line rendering. Not done: the bilingual-rater adequacy test, the fake-door metric, a one-click batch burn-in of every language, TTS voiceover (phase 2).

---

## 9. Projects, presets and brand kit — 160 · S–M

**The problem in users' words**
- "What I would miss the most would be presets" — alin23, HN https://news.ycombinator.com/item?id=47595695
- "The expensive part in this category is usually reusable presets, not the raw recording." — siimsiim, r/macapps, ≈Apr 2026 https://www.reddit.com/r/macapps/comments/1sblakx/does_anyone_have_a_cheaper_or_free_screen_studio
- A Screen Studio user found their default preset broken after an update: "my default preset has the cursor set to zero. very confusing!" — https://hub.screen.studio/?b=6376af1f65cdfb454db68d01
- Recordly lists "Save your projects as .recordly files and come back to them later" as a launch feature — r/macapps (link in #2)

**How often:** Screen Studio watermark/logo 93, FocuSee intro/outro 119, plus HN and Reddit mentions.

**Willingness to pay:** alin23 pays Screen Studio by the month mainly for this, and siimsiim calls presets the part people pay for.

**Competitors:** Both have presets. Lens has none (inventory gap: no style presets, project save/versioning or autosave).

**Proposed Lens feature:** A versioned `.lens` project folder (source media plus plan JSON with history), named presets for look, camera, zoom and caption style, and a brand kit (logo watermark, colours, fonts, intro/outro card). Presets live as importable files so a team can share one look.

**Build size:** S–M.

**How to test:** Round-trip tests (save → reopen → byte-identical render). Measure preset reuse: share of exports that use a saved preset after 2 weeks of dogfooding.

**Status (2026-11-09): presets and brand kit built, first version.** `.lenspreset` files (seven sections, versioned schema with migration), five built-in presets, partial apply as one undo step, a library with live thumbnails, default for new projects, import / export; a brand kit (colours, derived backdrop, caption highlight, fonts, logo watermark, intro / outro cards) that every themed element inherits (see `docs/Presets.md`). Measured on exports: watermark alpha within 0.0036 of target and 0 px off position; a brand primary change reaches the annotation box, caption highlight and backdrop (e.g. #1c7ed6 read back as (29.0, 125.8, 216.6) on the box); preview ↔ export SSIM on brand frames mean 0.987 / min 0.972. Save → apply round trip is byte-identical for preset files. Not done: the versioned `.lens` project folder with history and autosave, a brand library shared across projects, the preset-reuse metric.

---

## 10. Never lose a take: crash-safe autosave, drift-free long recordings, salvage — 150 · M–L (gate)

**The problem in users' words**
- "How are you releasing untested buggy versions for a paid software?" ... "Paid users shouldn't have to hack their way to recovering recordings." — Cap #1961, Windows 11, Jul 1 2026 https://github.com/CapSoftware/Cap/issues/1961
- "When recording videos longer than approximately 5 minutes, the cursor gradually becomes out of sync with the video." — Cap #2144, Aug 24 2026 https://github.com/CapSoftware/Cap/issues/2144
- "Cap rapidly consumes all available VRAM and system RAM ... the Cap process becomes completely unkillable ... forcing a hard reboot" ... "I just need a reliable way to salvage these 16-minute recordings" — Cap #1761, Apr 26 2026 https://github.com/CapSoftware/cap/issues/1761
- "the video track runs noticeably faster than the audio ... final export entirely unusable"; "20 mins long. All the audio/video was desynced at the end"; "We need a way to downgrade" — FocuSee board https://focusee-voice.imobie.com/p/audiovideo-desync-on-long-recordings-v233
- "Cap completely ate several recordings for me ... Switched back to OBS" (the_angry_angel) and "Cap routinely fails to render videos properly. The mouse ends up way off" (nprateem) — HN, ≈Oct 2026 https://news.ycombinator.com/item?id=50219193
- "tried cap and screensage ... many bugs and UX oddities ... ScreenStudio is reliable" — canxerian, HN https://news.ycombinator.com/item?id=47595695
- "Every Windows recorder I tried ... I tried open-source options and couldn't use them; they were full of bugs and the authors were burned out" — r/windowsapps https://www.reddit.com/r/windowsapps/comments/1tp8tlx/i_got_tired_of_maconly_screen_recorders_so_i/
- Screen Studio itself: X complaints "latest update broke" 11, "export failures" 6 (https://unnudged.com/catalog/screen-studio); hub posts "SS4.0 Video Export Quality Issue" and "Export is failed" (https://hub.screen.studio/?b=6376af1f65cdfb454db68d01)

**How often:** The most frequent complaint by raw count across every product, in issues, HN, X and Reddit.

**Willingness to pay:** The clearest "switched because" evidence in the dataset: people return to a $29/mo tool or to free OBS because it is reliable. "paid for CleanShotX ... just works" (roboyoshi, HN 50219193). Being reliable is what makes paying feel safe.

**Competitors:** Screen Studio advertises 2-second crash-safe saves (inventory REC-18). Cap and FocuSee have public drift, loss and export failures.

**Proposed Lens feature: "Unlosable."** Write fragmented MP4/segment files every ≤2 s. Use a single monotonic capture clock for screen, cursor log, mic and system audio, and stamp frames at **capture** time, not dequeue time; the Cap #2144 thread pins the drift on exactly that. Run a drift self-check on stop. Offer one-click "Salvage" that renders the raw segments with the cursor even when the project is corrupt. Keep previous app versions downloadable.

**Build size:** M for autosave and the salvage path; L in total because it depends on native capture.

**How to test:** Soak tests: 60-minute recordings at 60 fps on 3 machine classes with kill -9 at random points. Pass criteria: zero lost seconds beyond 2 s, cursor/video and A/V drift under 1 frame at 60 min (measure with the harness `cursortrack.py` and `audio.py`), export RAM bounded.

---

## 11. Pro hand-off: cursor as alpha layer, ProRes 4444, NLE project export — 144 · M

**The problem in users' words**
- "Screen Studio's cursor treatment is rendered into the exported footage before those edits happen. Graphics added afterward sit above the cursor ... Exporting the cursor, including its movement, smoothing, and click effects, as a separate video layer with an alpha channel." — Screen Studio hub https://hub.screen.studio/?b=6376af1f65cdfb454db68d01
- "Now that ProRes 4444 is available as render format, add transparent background option to be rendered with alpha." — same hub page ("Render with alpha")
- "It would be awesome if you could have no background at all." — mnosz, r/macapps (link in #2)
- "I'd rather have the metadata from click and typing events and use that to create a davinci project..." — __mharrison__, HN https://news.ycombinator.com/item?id=47595695
- A pro pipeline: "Screencap via Screenflow ... output ProRes HQ for After Effects" — rfoil, r/instructionaldesign (link in #2)

**How often:** Screen Studio hub: export camera and screen separately 54, transparent background 149 (rejected by Screen Studio), export to AE/Resolve XML 17, plus the new posts.

**Willingness to pay:** Agencies and training teams with After Effects pipelines are the high-budget end of the market (rfoil's team runs a dedicated workstation).

**Competitors:** Screen Studio rejected transparent backgrounds and bakes the cursor in. FocuSee has no ProRes.

**Proposed Lens feature:** Export stems: screen (no cursor), cursor plus clicks (ProRes 4444 alpha), camera (alpha when cutout), captions (SRT plus alpha), and an FCPXML/Resolve timeline with zooms as keyframes. Add a "no background" mode that renders alpha.

**Build size:** M. The compositor already renders these layers separately; the work is muxing and writing the XML.

**How to test:** Import into Resolve, FCP and Premiere and check the frame-exact alignment of the stems (difference against the flattened render equals 0). 3 agency users try it for one paid project.

---

## 12. A cursor that matches the UI — 144 · M

**The problem in users' words**
- "hover states appear to trigger before my cursor actually moves over the elements. It seems like there may be a timing or synchronization issue between the cursor movement and the recorded UI interactions. This makes the recording look unnatural" — Screen Studio hub https://hub.screen.studio/?b=6376af1f65cdfb454db68d01
- "The cursor always seemed to lag so far behind the actual clicks and hover animations." — d3mueller, r/macapps (link in #2)
- Cap cursor drift (#2144, quoted in #10)

**How often:** 3–4 sources. It is a quality signal people notice the moment they see it ("The first thing I noticed was the waaaay better cursor smoothing" — d3mueller).

**Willingness to pay:** It is why a tool wins a side-by-side (d3mueller "Instant download").

**Competitors:** Every smoothing implementation trades lag for smoothness. Screen Studio only offers turning smoothing off per fragment for drop-downs (inventory CUR-01).

**Proposed Lens feature: "UI-locked smoothing."** Constrain the One Euro filter so the smoothed cursor is exactly on the real position at each click and at each hover-state change. Detect hover changes as frame-difference spikes in a small radius around the real cursor, and treat them as soft keyframes. Lag is allowed only in between.

**Build size:** M, built on the existing smoother and the harness `cursortrack.py`.

**How to test:** Measure the maximum offset between the smoothed and raw cursor at clicks (target 0 px) and at hover-change frames (≤4 px) on 20 sessions. Blind A/B "which looks more natural".

---

## 13. Instant share link from a local-first app — 144 · M–L

**The problem in users' words**
- "one of the biggest friction points in Screen Studio is the wait time required to export the video locally and then upload it ... With Loom ... The moment I hit stop, I immediately have a shareable link in my clipboard." — Screen Studio hub, Mar 6 2026 https://hub.screen.studio/p/feature-requests-for-roadmap-instant-cloud-uploadsharing-loom-style-and
- "Can you guys send an automated email ... have the option to receive an email back once the client watches the video like loom?" — Screen Studio hub https://hub.screen.studio/?b=6376af1f65cdfb454db68d01
- "The only exception is for features that have ongoing infrastructure costs (like shareable links or hosting), where you'll either be able to use your own storage/providers or choose optional paid add-ons" — Dina developer, r/macapps (link in #4)

**How often:** FocuSee storage integration (Drive/YouTube/Dropbox) 100 votes and "someone watched your video" 7; Screen Studio embed code 50, view notifications; plus the posts above.

**Willingness to pay:** People pay Loom per seat for this (see the Loom pricing evidence below). Sharing is the feature that justifies recurring revenue, and users accept a paid add-on for hosting.

**Competitors:** Screen Studio: share links capped at 30 min (inventory REC-26). Loom: instant but expensive per seat. Lens: none.

**Proposed Lens feature:** Progressive upload during recording to **the user's own** S3/R2/Drive/Dropbox, then a static player page and a link on stop. A polished re-render replaces the file in place. Optional "viewed" webhook. An optional Lens-hosted add-on is the only metered item.

**Build size:** M–L.

**How to test:** Time from stop to link (target <3 s for a 5-minute take). Attach rate of the BYO-storage setup in a beta.

---

## 14. Transitions plus enter/exit animations — 144 · M

**The problem in users' words:** These are vote-heavy titles, not quotes: Screen Studio "enter/exit animations" 312 and "transitions" 127 (https://hub.screen.studio/?sortBy=upvotes%3Adesc); FocuSee "Add Audio/Video/Transitions/Titles" 303, planned (https://focusee-voice.imobie.com/?sortBy=upvotes%3Adesc). A Recordly user asked for "fade in-out effects for the text" (kc-otick, r/macapps, link in #2).

**How often:** About 740 combined votes.

**Willingness to pay:** It is part of FocuSee's most-voted request, and Notch markets "Annotations ... with enter and exit animations" for its paid licence.

**Competitors:** Both have only basic transitions between layout changes.

**Proposed Lens feature:** One animation system for every overlay (callouts, captions, camera, title cards): presets for fade, slide, scale and blur-in, spring-timed like the camera. Plus cut transitions (crossfade, zoom-through, swipe) at cut points.

**Build size:** M. **How to test:** A/B a demo with and without transitions; check that render time grows by under 5%.

---

## 15. One recording → 16:9 + 9:16 + 1:1 cuts with re-aimed zooms — 135 · S–M

**The problem in users' words:** FocuSee "camera layout flexibility": "vertical video is the dominant content style" (6 votes, https://focusee-voice.imobie.com/?sortBy=upvotes%3Adesc). Screen Studio "zoom <100%" for vertical social formats has 63 votes (https://hub.screen.studio/?sortBy=upvotes%3Adesc). Screen Studio removed its cursor-driven "Always keep zoomed in" crop in 4.0 (inventory ZM-09).

**How often:** Moderate. **Willingness to pay:** Creators post product updates on several platforms (r/SaaS $50k recorder founder: "I share these updates on social media by recording changes in the app", https://www.reddit.com/r/SaaS/comments/1vn4x5h/my_screen_recording_app_crossed_50k_in_revenue/).

**Competitors:** Screen Studio re-aims zooms when the aspect ratio changes (ZM-14) but exports one aspect at a time.

**Proposed Lens feature:** "Export set." One click renders 16:9, 9:16 and 1:1, each with its own zoom framing (smart framing already exists) and caption layout. Keep the cursor inside a safe area per aspect.

**Build size:** S–M. **How to test:** For each aspect, measure the share of frames where the cursor and click target stay in frame (target 100%).

---

## 16. Windows as a first-class platform — 120 · L (gate)

**The problem in users' words**
- "Every Windows recorder I tried was either stuck in 2014 (clunky timeline, no auto-zoom, ugly export), or had a decent UI but freemium-locked the parts I actually needed. The polished ones, like Screen Studio, are Mac-only because that is where the budgets are. That felt unfair to me." — r/windowsapps, ≈May 2026 https://www.reddit.com/r/windowsapps/comments/1tp8tlx/i_got_tired_of_maconly_screen_recorders_so_i/
- "The annoying gap on Windows is recording plus cleanup in one place: click zooms, cursor smoothing, captions, blur/mosaic, and clean export presets." — AnooshDoment (vendor, disclosed), r/screenrecorders https://www.reddit.com/r/screenrecorders/comments/1wu0g5q/i_tested_12_screen_recording_software_options_so/
- "Then I'll pitch this to a few users in our organization that were looking for a Camtasia alternative." — tejanaqkilica, r/windowsapps (link above)
- The Windows reliability failures in #10 (Cap #1961, #1761) are all Windows 11.

**How often:** The Screen Studio "Windows" request has 302 votes and is marked **rejected**, so that demand will stay unserved. A commenter notes "at least a dozen of Windows apps that were inspired by Screen Studio" exist, and the same thread says the open-source ones are buggy.

**Willingness to pay:** Organisations buying Camtasia replacements; Notch sells a $49 commercial licence. FocuSee's Windows builds trail macOS (2.5.0 on Mac 27 Aug 2026, 2.5.2 on Windows 15 Oct 2026, per inventory).

**Proposed Lens feature:** Ship Windows at the same time as macOS: native capture via Windows.Graphics.Capture, WASAPI loopback, one project format on both. Make reliability (#10) the acceptance bar.

**Build size:** L (native capture has not started). **How to test:** A Windows-only waitlist page with a price; count sign-ups against the Mac waitlist. A beta on 10 hardware configurations (AMD iGPU, hybrid graphics, HiDPI, multi-monitor), the exact cases Cap fails on.

---

## 17. Narration after the fact: per-line voiceover, import audio — 120 · S–M

**Evidence:** Screen Studio "voice over" 343 (in progress) and "import audio" 325 (https://hub.screen.studio/?sortBy=upvotes%3Adesc); FocuSee "Add Audio..." 303 (link in #14). A Screen Studio user's "Different audio input options" post: "I cannot use my original microphone as another input; therefore, I have to record separately" (https://hub.screen.studio/?b=6376af1f65cdfb454db68d01). Dina sells "Microphone voiceovers recorded inside the editor ... No importing files. No syncing." (link in #4).

**Willingness to pay:** It is in the top 5 of both vendors' boards. **Competitors:** Screen Studio in progress; FocuSee planned.

**Proposed Lens feature:** Record a voiceover over a selected range, with optional auto speed-fit of the video to the narration length (speed ranges already exist). "Re-record this sentence" from the transcript view. Import WAV/MP3 to a track.

**Size:** S–M. **Test:** Measure task time for replacing a fumbled sentence against re-recording the take.

---

## 18. Camera scenes: camera-only cuts, hide-when-silent, move/resize in post — 108 · S–M

**Evidence:** "I'm looking to switch from loom to cap (and currently pay for both), but I can't do that until I have camera-only video recording" — dannysmith, Cap #504 https://github.com/CapSoftware/Cap/issues/504 (Cap shipped it in Oct 2026). Screen Studio "camera resize/move in post" 61, "crop camera" 57; FocuSee "replace webcam with post facecam" 20 and "moving camera during recording" 15. A Screen Studio 4 complaint: "I could control each additional camera layout setting their Camera Size for example, now its just not possible" (https://hub.screen.studio/?b=6376af1f65cdfb454db68d01).

**Willingness to pay:** dannysmith pays for two tools until this exists. **Lens state:** the `hideDuringSilence` config exists but nothing reads it (inventory CAM-09).

**Proposed Lens feature:** Wire up hide-when-silent using the VAD already used for pause removal. Add a full-screen camera cut on a range, per-layout camera size, and a camera-only recording mode.

**Size:** S–M. **Test:** Rate the naturalness of auto camera hides on 10 talking sessions.

---

## 19. Hotkey zoom markers and a "don't zoom" modifier while recording — 108 · M

**Evidence:** "make zooms opt-in, for example by pressing a keyboard shortcut while recording to mark the moments that should become zooms in the editor ... doing it during the screen recording still matters because it would save time" — haystack_in_needle, r/macapps (link in #2). FocuSee "zoom control during recording (hold CTRL to not set zoom point)", 29 votes (https://focusee-voice.imobie.com/?sortBy=upvotes%3Adesc). "manual hotkey zoom ... the timing syncs better with narration, auto-zoom always felt slightly behind what I was explaining" (PushPlus9069, vendor-linked, r/macapps #2 link). "Does the auto zoom happen live while you record" (dppeak, r/macapps, link in #4).

**Competitors:** Screen Studio has recording flags (REC-14) that only mark the timeline and don't drive zooms.

**Proposed Lens feature:** During recording, a held modifier suppresses click zooms; a tap creates a "zoom here" marker. The #2 planner treats markers as must-keep and suppressed spans as no-zoom.

**Size:** M (it needs the capture hotkey hook). **Test:** Count zoom edits per minute after recording, with and without markers.

---

## 20. Freeze frame, still images, full-screen title cards — 90 · S

**Evidence:** "not even a freeze frame" — alin23, HN (link in #1). Screen Studio: freeze frame 60, add still images 55, full-text slides 482 (https://hub.screen.studio/?sortBy=upvotes%3Adesc).

**Proposed Lens feature:** Hold-frame on a range (the cursor can keep moving over it, which is handy for explaining a static screen), image and title-card clips that use the brand kit.

**Size:** S. **Test:** Unit render tests; usage share in beta.

**Status (2026-11-11): built, first version (branch feat/freeze-frames-015, not merged).** Hold freeze on a range (the screen picture stops, the cursor can keep moving or be hidden, audio / captions / zooms / webcam / annotations keep playing, length unchanged), pause (the whole video stops, silent, the rest shifts), image slides (Fit / Fill, caption) and title cards that follow the brand kit; Freeze lane and an Insert group in the editor, the same plan in the preview and the browser export the desktop app uses; old projects plan byte-identically (see `docs/FreezeFrames.md`). Measured on the exported MP4 (desktop export path): held picture drift 0.00 px (bound 1.5) while the cursor moved 63 px; pause frames identical (0.01, bound 3); preview vs export 2.2–3.0 mean |RGB| (bound 12); 351 frames = plan; audio −14 dBFS around the pause, −120 dBFS inside it. Not done: usage share in beta, video clips as inserts.

---

## 21. Light on the machine: background render, bounded RAM, no demo lag — 72 · M

**Evidence:** "Ever since the update, my macbook becomes almost unusable when a file is rendering ... at least I was able to record another video while one was rendering in the background" — Screen Studio hub https://hub.screen.studio/?b=6376af1f65cdfb454db68d01. Cap #1761 (export exhausts VRAM/RAM, quoted in #10); a Cap issue on ~15 GB RAM use (#1589, top issues list). "newer tools with live transcription and cursor tracking tend to make the browser lag right when youre trying to demo a heavy web app" — NuikaStarki25, r/screenrecorders (link in #16). "editing slow" 5 on the Screen Studio X summary (Unnudged).

**Proposed Lens feature:** A low-priority render queue with streaming decode (fixed frame cache), and nothing heavy during capture: transcription and analysis run after stop.

**Size:** M. **Test:** Peak RSS during a 30-minute 4K export (target <2 GB). CPU overhead during capture (target <10% on an M1).

---

## 22. Crisp small text in zooms — 72 · M–L

**Evidence:** "Could you include a short raw sample from each recorder? Same screen, small text and scrolling." — Fresh-Daikon-9408, r/screenrecorders (link in #16). "Screencap ... on a Mac with a retina display. That gives us twice the normal resolution ... zoom in about 3x" — rfoil, r/instructionaldesign (link in #2). Screen Studio markets local AI upscaling (inventory ZM-12).

**Proposed Lens feature:** Capture at native backing scale, and add text-aware super-resolution only inside zoomed regions.

**Size:** M–L. **Test:** OCR accuracy on zoomed small text against baseline.

---

## 23. Music bed with automatic ducking — 60 · S

**Evidence:** Screen Studio "music" 159 (https://hub.screen.studio/?sortBy=upvotes%3Adesc). Dina and ShotGlass both market adding and mixing music (links in #4 and #2).

**Proposed Lens feature:** A music track that ducks automatically under VAD speech and fades at the ends. **Size:** S. **Test:** Loudness check (speech-to-music LU gap ≥ 10 LU).

**Status (2026-11-11): built, first version (branch feat/music-ducking-015, not merged).** A music bed under the whole video: three built-in beds synthesised by Lens (CC0) or an imported file, level set relative to the speech by loudness, automatic ducking under the speech found from the mic's measured silences (look-ahead attack, hold, release, no pumping in short gaps), fades, loop, and an Audio-tab graph of the level; the same envelope in the preview, the desktop export and the Python export (see `docs/Music.md`). Measured on the exported MP4 (desktop export path) with ffmpeg's ebur128 per band: speech 21 LU above the music during speech (target ≥ 10 LU met), the music comes back 14.9 LU in the gaps (depth set to 15), preview and export within 0.0 LU of each other. Not done: several music clips / music that follows cuts, loop cross-fade for imported files, real-voice test, usage share.

---

## 24. Platform export presets — 60 · S

**Evidence:** "For App Store preview videos, can it export at the exact resolutions and frame rate Apple requires, or is that still a manual step afterward?" — dppeak, r/macapps (link in #4). "clean export presets" — AnooshDoment (link in #16). The inventory gap EXP-03/08 says there are no export presets.

**Proposed Lens feature:** Presets for App Store previews (every required size), YouTube, LinkedIn, X and Slack-under-a-size-limit, with a size estimate. **Size:** S. **Test:** App Store Connect accepts the output on the first upload.

**Status (2026-11-11): built, first version.** Export… > Video picks a platform preset: YouTube 1080p 30 / 60 fps (8 / 12 Mbps), YouTube Shorts and TikTok / Reels (1080×1920), X (≤ 140 s, ≤ 512 MB), LinkedIn (≤ 30 Mbps, 256×144–4096×2304), App Store previews 886×1920 / 1920×886 / 1080×1920 / 1200×1600 (≤ 30 fps, 11 Mbps avg / 12 peak, 15–30 s, 500 MB), GIF and Custom (own bitrate and size cap); a size estimate and warnings against each platform's limits; `export.video` in the project (absent = the old export); size-cap re-encode and GIF with ffmpeg in the desktop (no-Python) path and the reference path (see `docs/ExportPresets.md`). Measured on exports (both paths): exact 1080×1920 / 886×1920 canvases at 30 fps with every plan frame, average bitrate under the preset's peak, a 0.4 MB cap met from 1.03 MB in one pass with the duration kept, GIF at the set width / frame count with the loop block; on busy content an 8 Mbps preset averages 8.64 Mbps. Not done: the demand's test (an App Store Connect upload), a Slack preset (Custom + cap covers it), two-pass encodes, Windows / macOS runs.

---

## 25. Pre-flight check — 54 · S

**Evidence:** "Nothing is worse then spending all your time recording just to find out that the audio was not on" — FocuSee "test sound before recording", 27 votes, plus "waveform on recording head" 15 (https://focusee-voice.imobie.com/?sortBy=upvotes%3Adesc). Cap issue "no mic audio" #1740 (top issues list).

**Proposed Lens feature:** Live meters for the mic and each system-audio source; a red banner if a source is silent for 5 s while recording; a Do-Not-Disturb toggle. **Size:** S (with capture). **Test:** The silent-mic banner fires within 5 s in 100% of injected-silence tests.

---

## 26. Several windows as separate layers, rearranged in post — 48 · L

**Evidence:** ShotGlass sells "Multi-window support that can be arranged after recording" (426-upvote launch, link in #2). RoosterOnCommand wants before/after layering (link in #4). Screen Studio "multiple windows same screen" 28.

**Proposed Lens feature:** Capture N windows as separate streams; lay them out after recording (side-by-side or before/after). **Size:** L. **Test:** Fake-door first.

---

## 27. AI title, description and chapters from the transcript — 40 · S

**Evidence:** FocuSee "AI summary/title/description" 16 votes (link in #25). **Proposed Lens feature:** A local LLM drafts a title, description and chapter markers from the transcript at export. **Size:** S. **Test:** Edit distance between the drafted and the final title.

**Status (2026-11-11): built, first version (branch feat/ai-chapters-015, not merged).** Export > Title & chapters drafts a title, a three-sentence description and chapters from the transcript on the device. Not a local LLM as proposed: an English-only, extractive, deterministic TypeScript pipeline (TextTiling + cohesion DP for chapters, key phrases for chapter titles, TextRank for title and description), so it runs in the desktop app without Python or a model and never says anything the speaker did not say. Edit, copy, YouTube chapter list and WebVTT downloads, markers on the timeline ruler, chapters + title + description written into the MP4 in both export paths (see `docs/Chapters.md`). Measured on a held-out four-topic transcript: 4 chapters, chapter starts 0 / 0 / 0 ms from the true topic changes (bound ±5 s), drafted in 38-43 ms (bound < 1 s), the MP4 carries 4 chapter atoms and the title tag on both paths. Not done: the drafted-vs-final title edit-distance metric with users, abstractive titles, other languages.

---

## 28. Multiple audio inputs — 18 · M

**Evidence:** Screen Studio "Different audio input options" (BlackHole user, quoted in #17). A r/macapps user routes several sources with Loopback into OBS (Thick_Edge5075, link in #4). **Proposed Lens feature:** Choose any number of input devices, each on its own track. **Size:** M (with capture).

---

## 29. Linux build — 16 · L

**Evidence:** martypitt wants Linux (HN, link in #1); Cap Linux issues #609/#1671 are among its top issues (https://github.com/CapSoftware/Cap/issues). **Proposed Lens feature:** Revisit after the Windows launch; the compositor and engine are portable, capture is not. **Size:** L.

---

## Pricing and business-model complaints

### A. Subscription fatigue: occasional users don't want monthly fees

- "A $30/month subscription is indeed too much, but I see it as a one time payment for that month when I release something, then I pause the subscription." — alin23, HN, ≈Apr 2026 https://news.ycombinator.com/item?id=47595695
- "a subscription seems weird for a tool like this. Most users would probably only need it occasionally" — RestartKernel, same thread
- "i used screen studio maybe 2-3 times over the course of 3 months" — zahradeenie, same thread
- "$30/mo is a bit much for what it does" — whywhywhywhy, same thread
- "I bought it when it was a flat fee for a year of updates... I'd happily pay for another, but not as a subscription" — vochsel, same thread
- "I paid $40 one-time when it was launched. Now it's $29/m subscription" — rakesh on X, quoted by https://unnudged.com/catalog/screen-studio. Same summary: "sub too expensive" 9 posts, "lifetime pulled" 5.
- "$108 a year, and the other option is $29 a month. These prices are more expensive than Cursor" — r/macapps https://www.reddit.com/r/macapps/comments/1n6ica3/looking_for_a_screenstudio_alternative_because/ (2025)
- "Camtasia is worth the money when in comes to capture. I hate the fact that they have switched to per-year pricing. I still use version from 2021 and it is great." — taubek, HN, Apr 2025 https://news.ycombinator.com/item?id=43692349. Reply: "It's annoying with the subscription if you need it sporadically."
- "Screen Studio does motion and effects ... its priced $29 monthly, a subscription hell" — Dina launch post, r/macapps https://www.reddit.com/r/macapps/comments/1sfufi6/im_tired_of_monthly_subscriptions_for_screen

**Per-seat and metered-AI anger (team tools)**
- Loom after Atlassian: "Before Atlassian acquired Loom, you mainly paid for people who recorded videos. After the change, companies are billed for everyone with an account in the organization ... a 100-person company where only 10 people actually create Loom videos ... Roughly a 10× price increase." ... "We recently canceled our Loom account" — Craig Hosang, LinkedIn, ≈Feb 2026 https://www.linkedin.com/posts/craighosang_i-think-thousands-of-companies-are-about-activity-7431737111403397120-qziU
- Descript AI credits: "After editing just one video all my monthly credits are gone. This is insane." (Feb 11 2026); "On the Creator plan ($35/month), I exhausted all 800 AI credits within 2 days of use while processing only 12 out of 1,800 available media minutes ... I've cancelled my subscription as a result." (Jun 15 2026); "I would appreciate a note on how expensive different actions are" (Jul 23 2026) — https://descript.canny.io/feature-requests/p/all-ai-monthly-credits-are-gone-after-one-edit-on-creator-plan
- Supademo: "adding additional creators can also start to get expensive ... I wish there was just an editor seat that wasn't an upcharge." — G2, 10/13/2026 https://www.g2.com/products/supademo/reviews
- Arcade: Toolradar notes core features were "gated behind the Growth plan, which in 2026 moved to a flat 297.50 dollars per month for 5 seats with each additional seat costing 150 dollars per month" (the plan was replaced by a $59/mo Pro plan on Nov 2 2026) — https://toolradar.com/tools/arcade
- FocuSee (from the inventory, vendor pricing): Advanced plan includes 300 AI credits a month; AI Avatar costs 150 credits per minute. Credits are a known anger point (above).

### B. Lifetime-deal and pay-once demand

- "I would be happy to pay $100 for unlimited access and be locked into the current version of the app" and "unlock for a week" — alin23, HN (link above). gobdovan suggested "buy forever, 1 year updates"; feznyng pointed to Sublime Text as the model (same thread).
- The market is answering with one-time prices: Dina $49 single-device / $99 three-device lifetime (r/macapps 1sfufi6); ShotGlass $17 at launch, then $29 one-time ("Messed around with it for like 30 min, hit my first render and just bought it" — oznng) https://www.reddit.com/r/macapps/comments/1tcrf24/i_made_a_screen_recorder_that_makes_your_demos/; TinyRec $39 one-time and ScreenOtter "$19 one-time" (r/macapps 1sblakx); toads.io "$29.99 lifetime deal" (r/screenrecorders 1wu0g5q); Notch $49 commercial, later free for commercial use (r/windowsapps 1tp8tlx). FocuSee sells a $199.99 lifetime that covers v2.x only (inventory) and ran an AppSumo lifetime deal.
- An indie Mac recorder shows the model can work: "My Mac app recently reached $50k of total revenue" (Screen Charm) — https://www.reddit.com/r/SaaS/comments/1vn4x5h/my_screen_recording_app_crossed_50k_in_revenue/
- Buyers want "lifetime" defined: "kindly provide your definition of 'lifetime.' ... covers all point version updates ... all number versions ... all versions regardless of (bogus) name changes" — Writesquire, r/macapps 1sfufi6.
- The economics hinge on on-device AI: "if they require server processing, a one-time $49 payment doesn't cover ongoing compute costs" (Downtown-Art2865) → "No per render server cost means lifetime actually pencils out, and the recordings never leave your machine." (dppeak) — r/macapps 1sfufi6.
- Licence portability matters: "What is the process of transferring a license from one device to the next?" (tejanaqkilica, r/windowsapps 1tp8tlx). FocuSee "device management" has 117 votes (https://focusee-voice.imobie.com/?sortBy=upvotes%3Adesc).
- The price-sensitive end exists: "Your pricing is very high compared to others, that are free" (possiblevector, r/macapps 1sfufi6), and free open-source tools (Recordly, OpenScreen, Cap) get 400+ upvote threads. But free tools lose users on reliability (#10).

### C. Windows gaps

- Screen Studio's "Windows" request: 302 votes, **rejected** (https://hub.screen.studio/?sortBy=upvotes%3Adesc).
- "The polished ones, like Screen Studio, are Mac-only because that is where the budgets are." (r/windowsapps 1tp8tlx). Organisations are looking for a "Camtasia alternative" on Windows (same thread).
- The Windows options people try are unreliable: Cap #1961, #1781 (≈50% of recordings fail on stop, per the bot summary in #1961), #1761 (unkillable export on Win 11). Open-source Windows ports are "full of bugs" (r/windowsapps).
- FocuSee is cross-platform but ships Windows later (inventory: 2.5.0 Mac 27 Aug 2026 vs 2.5.2 Windows 15 Oct 2026).

### D. What this suggests for Lens's model (recommendation, to validate)

1. **Pay once, own your version.** A one-time licence with 12 months of updates (the Sublime model the HN thread asked for), and you keep the last version you got forever. Write the "lifetime" terms in one sentence on the pricing page. The evidence brackets the price: $19–49 indie one-time tools on the low end, alin23's stated $100 ceiling for a pro, FocuSee's $199.99 v2.x lifetime at the top. **Test $49 personal / $99 commercial.**
2. **A short pass for occasional users.** alin23 literally asked for "unlock for a week". A $9–12 seven-day export pass serves the "2–3 times in 3 months" user without a subscription.
3. **No AI credits.** Transcription, translation, redaction and voice all run locally. Market it directly against Descript's credit backlash.
4. **Only infrastructure is recurring.** Hosted share links (#13) as an optional add-on, with BYO storage free. This matches what the Dina thread accepted.
5. **Seats by creator, never by viewer**, and licences that transfer between machines (self-serve deactivate). This answers the Loom and Supademo complaints.
6. **Windows on day one** is a pricing lever too: the high-budget buyers on Windows are organisations replacing Camtasia.

**How to test the model:** A fake-door pricing page with 3 options (one-time $49/$99, 7-day pass $12, $9/mo); measure clicks to "Buy" per option and run a Gumroad presale with refunds. Ask every churned beta user one question: "what would make you pay?"

---

## Top 10 at a glance

1. **Multi-take + auto best-take** (M): the most-voted ask in the category (535 + 468 + 216 votes); nobody picks takes for you. Lens's transcript makes it feasible. *Built 2026-11-09 (docs/Takes.md); record-another-take button still needs native capture.*
2. **Calm auto-zoom** (S–M): motion sickness and "constantly zooming" complaints in 4 communities. A zoom budget and comfort mode use Lens's existing spring camera.
3. **Auto-redaction** (M): a clean browser profile is a manual step today; detect tokens, emails and notifications on-device. *Built 2026-11-09 (docs/Privacy.md); user-supplied words and real-app testing still to do.*
4. **Callouts + auto step labels** (M): 249 + 223 + 482 Screen Studio votes; Screen Studio still lacks arrows and text.
5. **Demo-as-code** (L): teams stop making tutorials after UI redesigns; a scripted re-render reuses Lens's engine.
6. **MCP/CLI** (M): a fast-rising 2026 ask; Lens already has a CLI and plan model.
7. **Interactive demo + step-guide export** (L): the category with the highest prices (Supademo $27–38/user, Arcade up to $297.50/mo); built from the same click log. *Built 2026-11-09 (docs/InteractiveDemo.md); per-step clips, analytics beacon and pilot still to do.*
8. **On-device caption translation** (M): no Screen Studio or FocuSee support; no credits needed.
9. **Projects, presets, brand kit** (S–M): "presets" is what users say they pay for; Lens has none.
10. **Never lose a take** (M–L, gate): the top complaint by raw count (Cap, FocuSee, Screen Studio exports). The reason people go back to paid tools.

Strategic gate outside the top 10: **#16 Windows parity**. Screen Studio rejected it (302 votes), and the current Windows options fail on reliability.

---

## Sources (all accessed 2026-11-09, full-page fetch)

| Source | URL | Date on page |
|---|---|---|
| HN: OpenScreen is an open-source alternative to Screen Studio | https://news.ycombinator.com/item?id=47595695 | ≈Apr 2026 |
| HN: Camtasia per-year pricing comment | https://news.ycombinator.com/item?id=43692349 | Apr 15 2025 |
| HN: OBS 33 thread (Cap reliability comments) | https://news.ycombinator.com/item?id=50219193 | ≈Oct 2026 |
| Screen Studio hub, top requests | https://hub.screen.studio/?sortBy=upvotes%3Adesc | live board |
| Screen Studio hub, roadmap status | https://hub.screen.studio/roadmap/status | live board |
| Screen Studio hub, newest feature requests | https://hub.screen.studio/?b=6376af1f65cdfb454db68d01 | Sep–Nov 2026 posts |
| Screen Studio hub: instant cloud upload + subtitles | https://hub.screen.studio/p/feature-requests-for-roadmap-instant-cloud-uploadsharing-loom-style-and | Mar 6 2026 |
| Screen Studio hub: more automation/agent friendly | https://hub.screen.studio/p/more-automation-and-agent-friendly | Mar 17 2026 |
| FocuSee voice board, top requests | https://focusee-voice.imobie.com/?sortBy=upvotes%3Adesc | live board |
| FocuSee: A/V desync on long recordings | https://focusee-voice.imobie.com/p/audiovideo-desync-on-long-recordings-v233 | Jun–Aug 2026 |
| Cap #1961 untested buggy versions | https://github.com/CapSoftware/Cap/issues/1961 | Jul 1 2026 |
| Cap #2144 cursor drift | https://github.com/CapSoftware/Cap/issues/2144 | Aug 24 2026 |
| Cap #1761 Win11 export exhausts RAM/VRAM | https://github.com/CapSoftware/cap/issues/1761 | Apr 26 2026 |
| Cap #504 webcam-only mode | https://github.com/CapSoftware/Cap/issues/504 | May 2025–Oct 2026 |
| Cap issues list | https://github.com/CapSoftware/Cap/issues | live |
| Unnudged: Screen Studio X-post summary | https://unnudged.com/catalog/screen-studio | Oct 27 2026 |
| r/SaaS: tutorial videos broke after a redesign | https://www.reddit.com/r/SaaS/comments/1vg7ukk/our_tutorial_videos_broke_after_a_redesign_so_i | ≈Aug 2026 |
| r/SaaS: screen recording app crossed $50k | https://www.reddit.com/r/SaaS/comments/1vn4x5h/my_screen_recording_app_crossed_50k_in_revenue/ | ≈Aug 2026 |
| r/macapps: tired of monthly subscriptions (Dina) | https://www.reddit.com/r/macapps/comments/1sfufi6/im_tired_of_monthly_subscriptions_for_screen | ≈Apr 2026 |
| r/macapps: cheaper or free Screen Studio alternative | https://www.reddit.com/r/macapps/comments/1sblakx/does_anyone_have_a_cheaper_or_free_screen_studio | ≈Apr 2026 |
| r/macapps: Recordly launch | https://www.reddit.com/r/macapps/comments/1rsf44t/os_i_made_a_free_opensource_screen_studio/ | ≈Mar 2026 |
| r/macapps: ShotGlass launch | https://www.reddit.com/r/macapps/comments/1tcrf24/i_made_a_screen_recorder_that_makes_your_demos/ | ≈May 2026 |
| r/macapps: iOS recording and localisation | https://www.reddit.com/r/macapps/comments/1s6wbxr/what_tool_do_you_use_for_screen_recording_ios/ | ≈Apr 2026 |
| r/macapps: Screen Studio price "insane" | https://www.reddit.com/r/macapps/comments/1n6ica3/looking_for_a_screenstudio_alternative_because/ | 2025 |
| r/windowsapps: tired of Mac-only recorders (Notch) | https://www.reddit.com/r/windowsapps/comments/1tp8tlx/i_got_tired_of_maconly_screen_recorders_so_i/ | ≈May 2026 |
| r/screenrecorders: tested 12 recorders | https://www.reddit.com/r/screenrecorders/comments/1wu0g5q/i_tested_12_screen_recording_software_options_so/ | ≈Oct 2026 |
| r/instructionaldesign: zoom-ins and annotations workflow | https://www.reddit.com/r/instructionaldesign/comments/1rq88sp/screen_recording_workflow_for_software_training | ≈Mar 2026 |
| r/youtubers: messing up during recording | https://www.reddit.com/r/youtubers/comments/1k643g6/how_do_you_all_deal_with_messing_up_during | ≈Apr 2025 |
| G2: Supademo reviews | https://www.g2.com/products/supademo/reviews | reviews May–Oct 2026 |
| Toolradar: Arcade | https://toolradar.com/tools/arcade | checked Nov 2 2026 |
| Descript Canny: AI credits gone after one edit | https://descript.canny.io/feature-requests/p/all-ai-monthly-credits-are-gone-after-one-edit-on-creator-plan | Feb–Jul 2026 |
| LinkedIn: Craig Hosang on Loom pricing | https://www.linkedin.com/posts/craighosang_i-think-thousands-of-companies-are-about-activity-7431737111403397120-qziU | ≈Feb 2026 |

Vendor pricing for Screen Studio and FocuSee comes from `research/features/inventory.md` (sources in `research/evidence/sources.md`).

**Known gaps.** I did not reach Loom's or Camtasia's own feedback boards, Trustpilot or AppSumo review text in full (AppSumo appeared only in search snippets, which are not cited). Vote counts are a snapshot from 2026-11-09. Translation and dubbing demand rests on 5 user sources plus a crowded vendor market; vendor pages were not counted as demand. Reddit and HN dates are approximate because the pages show relative ages.
