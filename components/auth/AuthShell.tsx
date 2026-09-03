'use client'

/*
 * The shell every signed-out page wears.
 *
 * Login, register and forgot-password were three pages with three ideas of what
 * an input, a button and an error look like. They are one idea now — this file —
 * so a change to the field styling, the header or the footer lands on all three
 * rather than on whichever one somebody remembered to update.
 *
 * The shape is ONE SCREEN, split: the brand on a dark left panel, the form on a
 * light right one. No navigation bar, no footer, no sections underneath — see
 * the note in the component for what was there and why it went.
 *
 * Each page supplies its own copy and its own card body. `marks` — the stages
 * of the service, named across the foot of the brand panel — is passed by the
 * login page alone; register and forgot-password are utilities, and a utility
 * page that pads itself out with marketing wastes the reader's time.
 */

import { Link } from 'react-router-dom'

export type AuthStat = { value: string; label: string }

export const AUTH_CSS = `
        /* -- ONE SCREEN, SPLIT IN TWO ------------------------------------
           The brand on a dark half, the form centred in a light half. Nothing
           above, nothing below, nothing to scroll.

           It went the long way round to get here: a full marketing page with a
           navigation bar, four stage sections and a footer, then back to this.
           The split carries the brand on its own; the sections were a second,
           longer answer to a question the panel had already answered.

           Nothing about the sign-in behaviour changed through any of it -- the
           banners, the lockout meter, the OTP hand-off and the form below are
           the same markup, restyled. */

        .lp-page { min-height:100dvh; display:flex; flex-direction:column;
          background:#fff; color:#14254A;
          font-family:Inter,system-ui,-apple-system,'Segoe UI',sans-serif; }
        /*
          The logo, in the dark panel's top corner.

          Absolute rather than a row in the flow: the panel's content is
          vertically centred, and a logo in that flow would be pulled into the
          middle with it or would push the headline off centre. It belongs to the
          corner of the panel, so it is placed there and the centring ignores it.
        */
        .lp-brand { position:absolute; z-index:2;
          top:clamp(24px,3vw,40px); left:clamp(24px,4vw,60px); }
        .lp-brand img { height:28px; width:auto; display:block;
          /* The asset is navy; the panel is navy. */
          filter:brightness(0) invert(1); }

        /* The small print, pinned to the foot of the dark panel — there is no
           site footer any more for it to live in. */
        .lp-brand-foot { position:relative; z-index:1; display:flex; flex-wrap:wrap;
          align-items:center; justify-content:space-between; gap:12px;
          font-size:11.5px; color:rgba(255,255,255,.42); }
        .lp-brand-foot nav { display:flex; gap:18px; }
        .lp-brand-foot a { color:rgba(255,255,255,.42); text-decoration:none;
          font-weight:600; transition:color .15s; }
        .lp-brand-foot a:hover { color:rgba(255,255,255,.8); }

        /*
          ── A SPLIT HERO, AND WHY IT IS NOT A SOFTWARE LOGIN ────────────────

          Two panels the height of the screen: the brand on the dark left, the
          form on the light right. That composition is borrowed deliberately —
          it is the one the product had before, and it had presence the centred
          version never got near.

          What made the old one read as SOFTWARE was not the split. It was the
          mocked-up application window inside it: a title bar with three
          traffic-light dots, invented bar charts, a fake "GET /api/embed-token
          200 OK". A picture of the app behind the door tells a visitor they are
          signing in to something they already own, which is the wrong sentence
          for the one page seen by people who do not.

          So the split stays and the fake window goes. In its place the panel
          carries what a hero carries — a claim, a sentence, figures, and the
          four stages of the service named. No screenshot, so no promise about
          what is behind the door.

          Removed along the way: the sticky form rail, the scroll-crossing
          stages, the card measurement that positioned them, and later the whole
          page of chrome. All of it existed to make one tall scrolling column
          work, and this is not a column.
        */
        /* The WHOLE screen, not the screen less a header: there is no header,
           and nothing below the fold for the panels to stop short of. */
        .lp-hero { display:grid; grid-template-columns:1fr 1fr; align-items:stretch;
          min-height:100dvh; }

        /* The dark half. The gradient runs off-axis so the panel has a light
           source rather than a flat fill — the same reason the card has one. */
        .lp-hero-brand { position:relative; overflow:hidden;
          display:flex; flex-direction:column;
          padding:clamp(40px,5vw,76px) clamp(24px,4vw,60px);
          background:linear-gradient(155deg,#0c1a33 0%,#14254A 52%,#1d3f74 100%);
          color:#fff; }
        /* A faint grid, at very low contrast. It reads as engineering rather
           than as decoration, and unlike a screenshot it is not a claim about
           what the product looks like. */
        .lp-hero-brand:before { content:""; position:absolute; inset:0;
          pointer-events:none; opacity:.5;
          background-image:linear-gradient(rgba(255,255,255,.05) 1px,transparent 1px),
            linear-gradient(90deg,rgba(255,255,255,.05) 1px,transparent 1px);
          background-size:44px 44px; }
        .lp-hero-brand:after { content:""; position:absolute; pointer-events:none;
          width:520px; height:520px; border-radius:50%; top:-160px; right:-180px;
          background:radial-gradient(circle,rgba(252,147,76,.26),transparent 68%); }
        /* Centred, in both axes, and held to a measure.

           The logo keeps the corner; the copy does not follow it there. A
           centred block is what the reference sets, and it is the right call
           for this content anyway: the headline is two short lines and the
           figures are three columns, which read as a composition centred and as
           a ragged left edge when they are not. */
        .lp-hero-brand-in { position:relative; z-index:1; flex:1; width:100%;
          max-width:620px; margin:0 auto; text-align:center;
          display:flex; flex-direction:column; justify-content:center;
          align-items:center; }

        /* CENTRED in its half, not tucked against the split. The card was
           pinned to the panel's leading edge, which left it hanging off the
           middle of the screen with a field of white to its right — the panel
           is its own section, and a form is the only thing in it. */
        .lp-hero-form { display:flex; flex-direction:column; align-items:center;
          justify-content:center;
          padding:clamp(40px,5vw,76px) clamp(24px,4vw,60px); background:#fff; }
        .lp-form-note { font-size:11.5px; color:#9aa5b5; margin:18px 0 0;
          max-width:420px; line-height:1.5; text-align:center; }

        @media (max-width:1040px){
          /* One column, and the FORM first. Someone on a phone came to sign in;
             the brand panel is what they scroll to afterwards, if at all. */
          .lp-hero { grid-template-columns:1fr; min-height:0; }
          .lp-hero-form { order:-1; padding:32px 20px 8px; }
          .lp-hero-brand { padding:32px 20px 40px; }
          .lp-hero-brand-in { max-width:none; flex:none; margin-top:26px; }

          /*
            IN THE FLOW here, not in the corner.

            Absolute positioning is right when the panel is half the screen and
            its copy is centred in the remaining height — the logo owns a corner
            nothing else wants. Stacked, the panel is only as tall as its
            contents, so a corner and the top of the copy are the same place: the
            mark was drawn straight over the eyebrow chip.

            Put back in the flow it simply sits above the copy, and centred so it
            shares the axis everything below it is on.
          */
          .lp-brand { position:static; top:auto; left:auto; align-self:center; }
        }

        /*
          align-self, and without it this was a bug on every width.

          The chip is inline-flex, which sizes to its text — but it is also a
          flex ITEM of the column above, and a column stretches its items across
          the full width. So "ANTI-PIRACY PLATFORM" was drawn inside a 600px
          pill running the width of the panel. inline-flex describes how a box
          lays out its own children; it says nothing about how its parent sizes
          it.

          The tints are the light-on-dark pair rather than the ink-on-white one
          they were, since this sits on the dark panel now.
        */
        .lp-eyebrow { align-self:center;
          display:inline-flex; align-items:center; gap:7px; font-size:11.5px;
          font-weight:800; letter-spacing:.09em; text-transform:uppercase; color:#FDBE94;
          background:rgba(252,147,76,.14); border:1px solid rgba(252,147,76,.28);
          border-radius:999px; padding:6px 13px; }
        .lp-h1 { font-size:clamp(30px,3.1vw,50px); line-height:1.08; font-weight:800;
          letter-spacing:-.022em; margin:20px 0 0; color:#fff; }
        /* GOLD, not the orange the rest of the panel uses.

           It is what the reference sets, and the two are a brand pair already —
           the app's own loader runs one into the other. Gold also carries
           further on this navy than orange does, which is what an emphasised
           word in a headline is for. */
        .lp-h1 em { font-style:normal; color:#FFC82B; }

        .lp-lede { font-size:clamp(14.5px,1vw,16.5px); line-height:1.62;
          color:rgba(255,255,255,.72); margin:16px auto 0; max-width:34em; }

        /* The attribution line under the lede: smaller and dimmer, so it reads
           as a signature rather than as a third sentence. */
        .lp-powered { font-size:12.5px; color:rgba(255,255,255,.4);
          margin:14px 0 0; letter-spacing:.01em; }

        .lp-stats { list-style:none; display:flex; flex-wrap:wrap;
          justify-content:center;
          gap:clamp(22px,2.6vw,40px); margin:28px 0 0; padding:22px 0 0;
          border-top:1px solid rgba(255,255,255,.14); width:100%; }
        .lp-stats strong { display:block; font-size:clamp(22px,1.7vw,28px); font-weight:800;
          letter-spacing:-.01em; color:#fff; }
        .lp-stats span { display:block; font-size:12px; color:rgba(255,255,255,.55);
          margin-top:3px; }

        /*
          The four stages, named and joined.

          This is what sits where the fake dashboard used to. It is the shape of
          the service rather than a picture of the software, and it is the same
          four stages the sections below the fold set out in full — named here,
          explained there, so the hero says what this is without becoming the
          page.
        */
        .lp-marks { list-style:none; display:flex; align-items:center; flex-wrap:wrap;
          justify-content:center; gap:0; margin:30px 0 0; padding:0; }
        .lp-marks li { display:flex; align-items:center; gap:0; }
        .lp-marks span { font-size:11px; font-weight:800; letter-spacing:.1em;
          text-transform:uppercase; color:rgba(255,255,255,.9);
          border:1px solid rgba(255,255,255,.18); background:rgba(255,255,255,.06);
          border-radius:999px; padding:7px 14px; white-space:nowrap; }
        /* The join between two stages, drawn rather than punctuated: the service
           is a cycle, and an arrow says so where a comma would not. */
        .lp-marks i { display:block; width:clamp(10px,1.4vw,22px); height:1px;
          background:rgba(252,147,76,.55); margin:0 6px; }
        @media (max-width:520px){ .lp-marks i { display:none; }
          .lp-marks { gap:8px; } }

        /* No justify-self any more: the RAIL is the grid item now, and the card
           simply fills it. Left as justify-self:end the property was inert and
           read as if it were still doing the pinning. */
        /*
          ── Depth without a shadow ──────────────────────────────────────────

          No box-shadow at all. The card was floating on a 50px blur, which is
          the one way of showing depth that says nothing about the OBJECT — it
          describes the gap under it. This describes the card itself: a lit slab
          with a real edge.

          Three things do the work, and each is one physical claim:

            surface   a gradient from white to the page's own blue-grey. The top
                      faces the light, the bottom falls away, so the face reads
                      as very slightly convex rather than as a flat sticker.
            top edge  lighter than the border around it — the lit rim.
            base      2px instead of 1px, and darker. That extra pixel IS the
                      thickness; it is what makes the card sit ON the page
                      rather than in it, and it does so without casting
                      anything.

          Deliberately not an inset box-shadow, which is the usual way to fake a
          bevel: asked for no shadow, and a border is a truer description of an
          edge than a shadow drawn just inside one. Deliberately not a 3D
          transform either — perspective on a form tilts its inputs and softens
          its text, and this is the element on the page that most needs to be
          crisp and square to the reader.
        */
        .lp-card { width:100%; max-width:420px;
          background:linear-gradient(180deg,#fff 0%,#fdfefe 58%,#f4f7fb 100%);
          border:1px solid #e2e8f1;
          border-top-color:#f4f7fb;
          border-bottom:2px solid #d5dde9;
          border-radius:20px; padding:30px; }
        @media (max-width:1040px){
          .lp-card { max-width:none; } }
        .lp-card h2 { font-size:23px; font-weight:800; margin:0; letter-spacing:-.01em; }
        .lp-card-sub { font-size:13.5px; color:#64748b; line-height:1.5; margin:7px 0 24px; }

        .lp-label { display:block; font-size:11px; font-weight:800; letter-spacing:.06em;
          text-transform:uppercase; color:#8a96a8; margin-bottom:6px; }
        .lp-input-wrap { position:relative; }
        .lp-input-icon { position:absolute; left:13px; top:50%; transform:translateY(-50%);
          color:#a6b0c0; pointer-events:none; display:flex; }
        .lp-input { width:100%; height:46px; border:1px solid #e2e8f0; border-radius:12px;
          padding:0 14px 0 38px; font-size:14px; color:#14254A; background:#fbfcfe;
          outline:none; font-family:inherit;
          transition:border-color .15s, box-shadow .15s, background .15s; }
        .lp-input::placeholder { color:#aab4c2; }
        .lp-input:focus { border-color:#FC934C; background:#fff;
          box-shadow:0 0 0 3px rgba(252,147,76,.16); }
        .lp-eye { position:absolute; right:6px; top:50%; transform:translateY(-50%);
          width:32px; height:32px; display:flex; align-items:center; justify-content:center;
          border:none; background:none; color:#98a3b3; cursor:pointer; border-radius:8px; }
        .lp-eye:hover { color:#14254A; background:#f1f4f8; }

        .lp-btn { width:100%; height:48px; margin-top:4px; border:none; border-radius:12px;
          background:linear-gradient(135deg,#14254A,#1e3a6e); color:#fff; font-size:14.5px;
          font-weight:700; display:flex; align-items:center; justify-content:center; gap:9px;
          font-family:inherit; transition:filter .15s, transform .15s; text-decoration:none; }
        .lp-btn:hover:not(:disabled) { filter:brightness(1.12); transform:translateY(-1px); }
        .lp-spin { width:15px; height:15px; border:2px solid rgba(255,255,255,.35);
          border-top-color:#fff; border-radius:50%; animation:lpspin .7s linear infinite; }
        @keyframes lpspin { to { transform:rotate(360deg); } }

        .lp-idle, .lp-error { display:flex; gap:9px; align-items:flex-start;
          font-size:12.5px; line-height:1.5; border-radius:11px; padding:11px 13px;
          margin-bottom:14px; }
        .lp-idle { background:#fff8ec; border:1px solid #ffe2b8; color:#92600c; }
        .lp-error { background:#fff5f5; border:1px solid #f6d5d5; color:#b3091a; }

        .lp-attempts { border:1px solid #e8ecf2; background:#fbfcfe; border-radius:11px;
          padding:10px 13px; margin-bottom:14px; }
        .lp-attempts-last { border-color:#ffe2b8; background:#fff8ec; }
        .lp-attempts-row { display:flex; align-items:center; justify-content:space-between;
          gap:10px; font-size:12px; color:#5b6678; }
        .lp-attempts-row strong { color:#14254A; }
        .lp-attempts-last .lp-attempts-row, .lp-attempts-last .lp-attempts-row strong
          { color:#92600c; }
        .lp-attempts-note { font-size:11px; color:#8a96a8; }
        .lp-attempts-track { margin-top:7px; height:4px; border-radius:999px;
          background:#e8ecf2; overflow:hidden; }
        .lp-attempts-track > span { display:block; height:100%; border-radius:999px;
          background:#14254A; transition:width .3s; }
        .lp-attempts-last .lp-attempts-track > span { background:#FC934C; }

        /* Fields the register and reset forms need on top of the login pair.
           They live here rather than on those pages so all three keep one idea
           of what an input, a hint and a secondary link look like. */
        .lp-input-plain { padding-left:14px; }
        .lp-textarea { height:auto; min-height:98px; padding:12px 14px; line-height:1.5;
          resize:vertical; }
        .lp-form { display:flex; flex-direction:column; gap:15px; }
        .lp-row { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
        @media (max-width:560px){ .lp-row { grid-template-columns:1fr; } }
        .lp-req { color:#e05252; }
        .lp-hint { font-size:11.5px; line-height:1.45; margin-top:5px; min-height:15px;
          color:#7a8698; }
        .lp-hint a { color:#14254A; font-weight:700; text-decoration:none; }
        .lp-hint a:hover { color:#FC934C; }
        .lp-hint-ok { color:#16A34A; }
        .lp-hint-bad { color:#b3091a; }
        .lp-hint-wait { color:#b45309; }
        .lp-alt { margin-top:18px; text-align:center; font-size:13px; color:#64748b; }
        .lp-alt a { color:#14254A; font-weight:700; text-decoration:none; }
        .lp-alt a:hover { color:#FC934C; }
        .lp-tick { width:54px; height:54px; border-radius:50%; margin:6px auto 16px;
          display:flex; align-items:center; justify-content:center; font-size:25px;
          font-weight:800; background:rgba(22,163,74,.1); color:#16A34A; }
        .lp-done { text-align:center; }
        .lp-done h2 { margin-bottom:0; }
        .lp-back { display:inline-block; margin-top:6px; font-size:13px; font-weight:700;
          color:#14254A; text-decoration:none; }
        .lp-back:hover { color:#FC934C; }
        .lp-steps-dots { display:flex; align-items:center; gap:8px; margin-bottom:20px; }
        .lp-steps-dots i { width:26px; height:4px; border-radius:999px; background:#e4e9f0;
          display:block; }
        .lp-steps-dots i.on { background:#FC934C; }

        /* A form with five fields needs more than a sign-in box. Only the card
           widens now: the hero's two panels are an even split whatever is in
           them, so there is no grid template to restate. */
        .lp-card.is-wide { max-width:560px; }

`

export default function AuthShell({
  eyebrow, title, lede, powered, stats, marks, wide, children,
}: {
  eyebrow?: string
  title: React.ReactNode
  lede?: React.ReactNode
  /** The signature under the lede — "Powered by IP House". Smaller and dimmer
   *  than the sentence above it, so it reads as an attribution rather than as a
   *  third line of copy. */
  powered?: string
  stats?: AuthStat[]
  /**
   * The stages of the service, named, across the foot of the brand panel.
   *
   * A prop rather than something this shell knows, because only the login page
   * has a story to tell there — register and forgot-password are utilities, and
   * a utility page that pads itself out with marketing wastes the reader's time.
   */
  marks?: string[]
  /** A form with more than a username and a password needs a wider card. */
  wide?: boolean
  children: React.ReactNode
}) {
  /*
    ── TWO PANELS AND NOTHING ELSE ──────────────────────────────────────────

    No header, no footer, no sections below the fold. What is left is one
    screen: the brand on the dark half, the form on the light half, and the
    small print at the foot of each.

    What went, and it was a lot: a sticky navigation bar with How it works /
    Capabilities / Support, a site footer repeating those three links, a "How it
    works" section carrying the four stages with every service listed under
    them, and a "Built for rights holders" section with six capability chips.

    They were there to make this read as a website rather than a product's front
    door. The split panel does that on its own — a marketing claim, figures and
    the stages named, beside a sign-in box — and the sections were a second,
    longer answer to a question the hero had already answered. A page whose only
    job is to be signed in to should not need scrolling.

    The `aside` prop went with them. Nothing passes it now, and a slot no caller
    fills is a slot the next person has to work out the purpose of.
  */
  const year = new Date().getFullYear()

  return (
    <>
      <style>{AUTH_CSS}</style>

      <div className="lp-page">
        <main className="lp-hero">
          <div className="lp-hero-brand">
            {/* Top corner of the blue, on its own edge — see .lp-brand for why
                it is positioned rather than laid out. */}
            <Link className="lp-brand" to="/" aria-label="IP House">
              <img src="/newlogo.png" alt="IP House" />
            </Link>

            <div className="lp-hero-brand-in">
              {eyebrow && <span className="lp-eyebrow">{eyebrow}</span>}
              <h1 className="lp-h1">{title}</h1>
              {lede && <p className="lp-lede">{lede}</p>}
              {powered && <p className="lp-powered">{powered}</p>}

              {stats && stats.length > 0 && (
                <ul className="lp-stats">
                  {stats.map(s => (
                    <li key={s.label}><strong>{s.value}</strong><span>{s.label}</span></li>
                  ))}
                </ul>
              )}

              {/* Where the mocked application window used to be: the shape of
                  the service, named, rather than a picture of the software. */}
              {marks && marks.length > 0 && (
                <ul className="lp-marks">
                  {marks.map((m, i) => (
                    <li key={m}>
                      <span>{m}</span>
                      {/* Drawn between, never after the last one. */}
                      {i < marks.length - 1 && <i aria-hidden="true" />}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="lp-brand-foot">
              <span>&copy; {year} IP House. All rights reserved.</span>
              <nav>
                <Link to="/privacy">Privacy</Link>
                <Link to="/terms">Terms</Link>
              </nav>
            </div>
          </div>

          <div className="lp-hero-form">
            <div className={`lp-card${wide ? ' is-wide' : ''}`}>
              {children}
            </div>
            <p className="lp-form-note">
              &copy; {year} <strong>IP House</strong>. Confidential &amp; proprietary
              &mdash; unauthorized access is prohibited.
            </p>
          </div>
        </main>
      </div>
    </>
  )
}
