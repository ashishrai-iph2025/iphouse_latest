'use client'

/*
 * The shell every signed-out page wears.
 *
 * Login, register and forgot-password were three pages with three ideas of what
 * an input, a button and an error look like. They are one idea now — this file —
 * so a change to the field styling, the header or the footer lands on all three
 * rather than on whichever one somebody remembered to update.
 *
 * The shape is a marketing page, not an app shell: a real header with
 * navigation, a hero that leads with a sentence, and a footer. The form is one
 * element ON the page rather than one half OF it. See the CSS below.
 *
 * Each page supplies its own copy and its own card body. `aside` is for whatever
 * a page wants BELOW the hero — the login page puts the protection cycle and the
 * capability list there; the other two want nothing, because a utility page that
 * pads itself out with marketing is a page that wastes the reader's time.
 */

import { useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'

export type AuthStat = { value: string; label: string }

export const AUTH_CSS = `
        /* -- A WEB PAGE, NOT AN APP SHELL --------------------------------
           This was a locked 50/50 split: a dark product panel carrying a
           mocked-up dashboard window -- traffic-light dots, fake bars --
           beside a form. That composition reads as software you have already
           bought and are now signing into. Someone who has not signed in yet
           is on a SITE, so this is one: a real header with navigation, a hero
           that leads with a sentence instead of a screenshot, sections that
           stack and scroll, and a footer. The form is one element ON the page
           rather than one half OF it.

           Nothing about the sign-in behaviour changed -- the banners, the
           lockout meter, the OTP hand-off and the form below are the same
           markup, restyled. */

        .lp-page { min-height:100dvh; display:flex; flex-direction:column;
          background:#fff; color:#14254A;
          font-family:Inter,system-ui,-apple-system,'Segoe UI',sans-serif; }
        /* A measure, not a billboard. This ran full-bleed, which on a 2000px
           monitor pushed the headline and the sign-in card it belongs with to
           opposite edges with a desert between them -- the eye has to travel
           the whole screen to get from the sentence to the form. Filling the
           window is not the same as using it. The container grows with the
           viewport to a comfortable stop and then centres, so every layout
           below composes at a width a person can actually take in at once. */
        .lp-in { width:100%; max-width:1240px; margin:0 auto;
          padding:0 clamp(20px,4vw,56px); }

        .lp-nav { position:sticky; top:0; z-index:20; background:rgba(255,255,255,.88);
          backdrop-filter:blur(10px); border-bottom:1px solid #eef1f6; }
        .lp-nav-in { display:flex; align-items:center; justify-content:space-between;
          height:64px; gap:24px; }
        .lp-brand img { height:26px; width:auto; display:block; }
        .lp-nav-links { display:flex; align-items:center; gap:26px; }
        .lp-nav-links a { font-size:13.5px; font-weight:600; color:#5b6678;
          text-decoration:none; transition:color .15s; }
        .lp-nav-links a:hover { color:#14254A; }
        @media (max-width:760px){ .lp-nav-links { display:none; } }

        /* The wash runs across the whole page rather than a hero band, because
           there is no hero band any more — the top of the grid is where the
           gradient belongs, and a hard stop in px keeps it a top wash instead of
           tinting the entire (now much taller) column. */
        .lp-main { position:relative;
          background:linear-gradient(180deg,#f7f9fc 0%,#fff 560px);
          /* CLIP, not hidden, and the distinction is the whole reason this line
             needs a comment.

             The decorative glow below is 520px wide and hangs off the right of
             the content column, so something has to contain it — the hero it
             used to live in carried overflow:hidden. But overflow:hidden makes
             this element a scroll container, and a position:sticky descendant
             then sticks to THAT box instead of to the viewport. The box never
             scrolls, so the form would sit motionless at the top of the page and
             the rail would appear to do nothing.

             overflow-x:clip contains the glow WITHOUT creating a scroll
             container, which is exactly the difference between the two values.
             Leaving the y axis alone keeps the page scrolling normally. */
          overflow-x:clip; }
        /* The glow sits behind the sign-in card, so it hangs off the CONTENT
           column rather than the window: once the page stopped running to the
           edges, a decoration pinned to the viewport's right edge was lighting
           up empty margin a foot away from anything it belonged to. */
        .lp-main-in:before { content:""; position:absolute; top:-180px; right:-140px;
          width:520px; height:520px; border-radius:50%; pointer-events:none; z-index:0;
          background:radial-gradient(circle,rgba(252,147,76,.16),transparent 68%); }
        .lp-main-in > * { position:relative; z-index:1; }
        /*
          align-items:start, and it is load-bearing.

          The default value, stretch, makes every grid item as tall as its row,
          and a sticky element that is already the height of its container has
          nowhere to travel — so it simply never moves. That is the single most
          common way a position:sticky rail silently does nothing at all.

          The card is capped and pinned right rather than given a fraction of the
          row: a sign-in form stretched to 700px is not a better form.
        */
        .lp-main-in { position:relative; display:grid; align-items:start;
          gap:clamp(32px,4vw,64px); grid-template-columns:minmax(0,1fr) minmax(340px,420px);
          padding-top:clamp(44px,5vw,76px); padding-bottom:clamp(48px,5.5vw,84px); }

        /* The scrolling column. Its own containment context, so the layouts
           inside it can respond to the width THEY get rather than to the
           window's — see .lp-cycle. */
        .lp-col { min-width:0; container-type:inline-size; }

        /*
          Hold the intro to at least the card's height, so what follows it starts
          BELOW the form rather than level with the middle of it.

          --lp-card-h is measured and republished whenever the card resizes — see
          the ResizeObserver in this file. The 0px fallback matters: with no
          JavaScript, or before the first measurement, this is simply inert and
          the layout is the one it was.

          Only where there is something below to push down (lp-has-details), so
          the pages with no aside — register, reset, verify — do not gain a
          column of empty space under their copy to match a form nothing follows.
        */
        .lp-has-details .lp-intro { min-height:var(--lp-card-h, 0px); }

        /*
          The rail that holds the form still.

          The top offset clears the sticky 64px navbar and leaves a margin below
          it, so the card does not butt against the header when it lands.

          max-height + overflow so a form taller than the viewport is still
          reachable: pinned AND clipped would put the submit button somewhere
          nobody can scroll to, which is worse than letting it scroll away.
        */
        /*
          The right column: the pinned card, and the marker for where the stages
          begin their journey.

          align-self:stretch, and it is the whole reason the form stays put.

          A sticky element travels only within its CONTAINING BLOCK. The grid
          sets align-items:start, so this wrapper was as tall as its contents —
          the card plus the anchor, about 450px — and the card inside it pinned
          for those 450px and then scrolled away with the page. Stretching the
          wrapper to the row's full height gives the card the whole column to
          travel down.

          This is the second form of the same trap the grid comment describes: a
          sticky element with no room to move looks exactly like one that was
          never sticky. There it was too LITTLE stretch; here it was too much
          start.
        */
        .lp-side { min-width:0; align-self:stretch; }
        /* Measured, never seen. Height 0 so it adds nothing to the column, but
           it is in normal flow so its top and width are where the stages really
           begin. */
        .lp-side-anchor { height:0; margin-top:clamp(28px,3vw,44px); }

        /* Above the stages, so one shown in this column before scrolling cannot
           draw across the form. */
        .lp-rail { z-index:2; position:sticky; top:88px; align-self:start;
          max-height:calc(100dvh - 112px); overflow-y:auto;
          /* Room for the card's own shadow, which a clipping box would cut. */
          margin:-14px; padding:14px;
          /* Firefox and WebKit both hide the bar until it is needed. */
          scrollbar-width:thin; }

        @media (max-width:1040px){
          .lp-main-in { grid-template-columns:1fr; gap:40px;
            padding-top:44px; padding-bottom:52px; }
          /* Nothing pinned on a narrow screen: the form would cover the page it
             is meant to sit beside. */
          .lp-rail { position:static; max-height:none; overflow:visible;
            margin:0; padding:0; }
          /*
            order on .lp-SIDE, and it has to be. This column comes second in the
            markup, so collapsed to one column the form landed BELOW the copy and
            the whole how-it-works section — on a phone you scrolled past the
            marketing to reach the login.

            The declaration used to sit on .lp-rail, which was the grid item
            until it was wrapped to hold the anchor. After that it was inert:
            order applies to a grid or flex ITEM, and the rail became an ordinary
            block inside .lp-side. It read as though it were still doing the job.
          */
          .lp-side { order:-1; align-self:auto; }
          .lp-col { container-type:normal; }
          /* One column: the form is already above the copy, so nothing needs
             pushing past it and the floor would only add dead space. */
          .lp-has-details .lp-intro { min-height:0; } }
        .lp-eyebrow { display:inline-flex; align-items:center; gap:7px; font-size:11.5px;
          font-weight:800; letter-spacing:.09em; text-transform:uppercase; color:#FC934C;
          background:rgba(252,147,76,.1); border-radius:999px; padding:6px 13px; }
        .lp-h1 { font-size:clamp(32px,3.4vw,54px); line-height:1.07; font-weight:800;
          letter-spacing:-.022em; margin:20px 0 0; }
        .lp-h1 em { font-style:normal; color:#FC934C; }

        .lp-lede { font-size:clamp(15px,1.05vw,17px); line-height:1.6; color:#5b6678;
          margin:18px 0 0; max-width:32em; }
        .lp-stats { list-style:none; display:flex; flex-wrap:wrap;
          gap:clamp(26px,3vw,44px); margin:30px 0 0; padding:24px 0 0;
          border-top:1px solid #e8ecf2; }
        .lp-stats strong { display:block; font-size:clamp(24px,1.9vw,31px); font-weight:800;
          letter-spacing:-.01em; }
        .lp-stats span { display:block; font-size:12.5px; color:#7a8698; margin-top:3px; }

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
        .lp-card { width:100%; max-width:420px; margin-left:auto;
          background:linear-gradient(180deg,#fff 0%,#fdfefe 58%,#f4f7fb 100%);
          border:1px solid #e2e8f1;
          border-top-color:#f4f7fb;
          border-bottom:2px solid #d5dde9;
          border-radius:20px; padding:30px; }
        @media (max-width:1040px){
          .lp-card { max-width:460px; margin-left:0; } }
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

        .lp-sec { padding:clamp(52px,5.5vw,72px) 0; border-top:1px solid #eef1f6; }
        @media (max-width:760px){ .lp-sec { padding:52px 0; } }
        /*
          The sections came from being siblings of a full-bleed hero, so each one
          wraps its content in .lp-in — max-width plus side padding — to line up
          with the page. Inside the left column that measure is applied a second
          time: the column is already inset, so the content would be inset again
          and capped at a width it can no longer reach.

          Neutralised here rather than by removing .lp-in from the markup, so an
          aside written for the old full-width arrangement still composes.
        */
        .lp-col .lp-in { max-width:none; padding:0; }
        /* The first section follows the intro text, not a page edge, so it needs
           the rule above it that a full-bleed band got from its own background. */
        .lp-col .lp-sec:first-of-type { margin-top:clamp(40px,4.5vw,60px); }
        .lp-sec h2 { font-size:clamp(24px,2.1vw,33px); font-weight:800;
          letter-spacing:-.015em; margin:0; }
        .lp-sec-lede { font-size:15px; color:#5b6678; margin:11px 0 0; max-width:42em; }
        /* The cycle. Art on one side, the stages written out on the other --
           the diagram carries the SHAPE of the process (it closes, it repeats)
           and the list carries what each stage actually does. Neither says the
           other's half, so neither is decoration. */
        .lp-cycle { display:grid; align-items:center; gap:clamp(28px,3vw,56px);
          grid-template-columns:minmax(0,1fr) minmax(260px,360px); margin-top:38px; }
        /*
          A CONTAINER query, not a viewport one.

          The cycle no longer spans the page — it lives in the left column, whose
          width is the window minus the form rail. Asked about the viewport it
          would read 1400px, stay in two columns, and squeeze the stage list into
          about 180px while the ring kept its 360. The list carries the actual
          service names; the ring is one word each.

          760px is where the list stops being readable beside the ring, measured
          against the longest heading rather than picked round.
        */
        /* Declared BEFORE the queries below, not after.

           A container or media block adds no specificity, so this rule and the
           overrides inside them tie at (0,1,1) and source order decides. Sitting
           last, this one silently won: the stacked ring kept its full 420px and
           the cap inside the container query looked applied but was not. */
        .lp-cycle-art svg { width:100%; height:auto; max-width:420px; display:block;
          margin:0 auto; }
        @container (max-width: 760px) {
          .lp-cycle { grid-template-columns:1fr; gap:36px; }
          .lp-cycle-art { order:-1; }
          /* Smaller stacked than beside: at full width it becomes the loudest
             thing on the page, which inverts the point — it introduces the
             list. */
          .lp-cycle-art svg { max-width:320px; } }
        /* The fallback for the collapsed single-column layout, where .lp-col is
           no longer a container. */
        @media (max-width:1040px){
          .lp-cycle { grid-template-columns:1fr; gap:36px; }
          .lp-cycle-art { order:-1; }
          .lp-cycle-art svg { max-width:320px; } }
        .lp-stages { list-style:none; margin:0; padding:0; display:grid; gap:20px; }

        /*
          ── Each stage crosses from the right column to the left ─────────────

          Before the page is scrolled the stages are in the RIGHT column, under
          the form. As you scroll, each one in turn fades out there, moves while
          invisible, and fades up slowly in its place under the ring. Scrolling
          back reverses it.

          THE MOVE IS NEVER SEEN, and that is the point. Sliding a heading across
          the page is motion the reader has to follow before they can read it,
          and it pulls the eye off the form the page exists for. So the position
          change happens between two keyframes a thousandth of a percent apart,
          at zero opacity — the element is already in its new place by the time
          it is visible again. What reads as movement is only the two fades.

          The width is pinned to the right column's for BOTH positions
          (--lp-side-w). If the block reflowed between the two places, the same
          heading would break across different lines and the crossing would read
          as a different block appearing rather than the same one arriving.

          A view timeline rather than JavaScript, because the reverse has to
          work: an IntersectionObserver fires once per crossing, so scrolling up
          either leaves everything landed or needs a second observer to undo it,
          and either way items snap instead of tracking the scroll.

          @supports is load-bearing. The resting state here is offset AND at some
          opacity, so without the guard a browser that cannot run scroll-driven
          animations would strand the stages mid-crossing forever. Outside it
          nothing is offset, nothing is hidden, and the stages simply sit in the
          left column.
        */
        @supports (animation-timeline: view()) {
          @media (prefers-reduced-motion: no-preference) {
            .lp-stages { max-width:var(--lp-side-w, none); }
            .lp-stages > li {
              animation: lpStageCross linear both;
              animation-timeline: view();
            }
            /*
              Staggered by hand, which is right here: the stages are 20px apart,
              so their own positions differ far too little to separate them, and
              on their natural ranges all four would cross at once.
            */
            .lp-stages > li:nth-child(1) { animation-range: entry 2% entry 52%; }
            .lp-stages > li:nth-child(2) { animation-range: entry 14% entry 64%; }
            .lp-stages > li:nth-child(3) { animation-range: entry 26% entry 76%; }
            .lp-stages > li:nth-child(4) { animation-range: entry 38% entry 88%; }

            @keyframes lpStageCross {
              /* Held in the right column, fully visible. */
              0%      { transform:translate(var(--lp-dx, 0px), var(--lp-dy, 0px)); opacity:1; }
              /* Gone from the right — quickly, it is a departure not an event. */
              24%     { transform:translate(var(--lp-dx, 0px), var(--lp-dy, 0px)); opacity:0; }
              /* The move. Invisible, and over in one frame. */
              24.001% { transform:none; opacity:0; }
              /* Arriving on the left, over most of the range, so it appears
                 slowly rather than blinking on. */
              100%    { transform:none; opacity:1; }
            }
          }
        }

        .lp-stages li { display:flex; gap:16px; align-items:flex-start; }
        .lp-stages b { font-size:11.5px; font-weight:800; color:#FC934C;
          letter-spacing:.09em; padding-top:4px; flex-shrink:0; }
        /* The headings are now the full service definitions, so they wrap. A
           line-height is what keeps a two-line heading from setting solid. */
        .lp-stages h3 { font-size:15.5px; font-weight:800; margin:0; line-height:1.35;
          max-width:34em; }
        .lp-stages p { font-size:13.5px; color:#5b6678; line-height:1.6; margin:5px 0 0;
          max-width:42em; }

        /* The services under each stage.
           Given their own class rather than being reached as a descendant li:
           the rule above puts display:flex and a 16px gap on every li in this
           list, which a nested one inherits — so each service would sit in a
           16px-indented flex row of its own for no reason. */
        .lp-svc { list-style:none; margin:7px 0 0; padding:0; display:grid; gap:4px; }
        .lp-stages .lp-svc li { display:flex; gap:8px; align-items:flex-start;
          font-size:13.5px; color:#5b6678; line-height:1.55; }
        .lp-stages .lp-svc li::before { content:"\\2022"; color:#FC934C; font-weight:700;
          flex-shrink:0; }

        /* Each arc draws itself once, in order, so the ring reads as a cycle
           being completed rather than four static gauges. Motion only -- the
           finished state is what CSS falls back to. */
        .lp-arc { animation:lpdraw .9s cubic-bezier(.4,0,.2,1) both; }
        @keyframes lpdraw { from { stroke-dashoffset:452.4px; } }
        @media (prefers-reduced-motion:reduce){ .lp-arc { animation:none; } }
        .lp-caps { display:flex; flex-wrap:wrap; gap:9px; margin:34px 0 0; }
        .lp-caps span { font-size:13px; font-weight:600; color:#14254A;
          border:1px solid #e4e9f0; background:#fbfcfe; border-radius:999px;
          padding:8px 15px; }

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

        /* A form with five fields needs more than a sign-in box. */
        .lp-main-in.is-wide { grid-template-columns:minmax(0,1fr) minmax(360px,560px); }
        .lp-card.is-wide { max-width:560px; }
        @media (max-width:1180px){
          .lp-main-in.is-wide { grid-template-columns:1fr; }
          .lp-main-in.is-wide .lp-rail { position:static; max-height:none;
            overflow:visible; margin:0; padding:0; }
          /* Same reason as the block above: the ITEM is .lp-side, not the rail. */
          .lp-main-in.is-wide .lp-side { order:-1; align-self:auto; }
          .lp-main-in.is-wide .lp-col { container-type:normal; }
          .lp-card.is-wide { margin-left:0; } }

        .lp-foot { margin-top:auto; border-top:1px solid #eef1f6; background:#fbfcfe;
          padding:30px 0; }
        .lp-foot-in { display:flex; flex-wrap:wrap; align-items:center;
          justify-content:space-between; gap:14px; font-size:12.5px; color:#7a8698; }
        .lp-foot-in nav { display:flex; gap:20px; }
        .lp-foot-in a { color:#7a8698; text-decoration:none; font-weight:600; }
        .lp-foot-in a:hover { color:#14254A; }
        .lp-foot-note { font-size:11.5px; color:#9aa5b5; margin:14px 0 0; }
`

export default function AuthShell({
  eyebrow, title, lede, stats, aside, wide, children,
}: {
  eyebrow?: string
  title: React.ReactNode
  lede?: React.ReactNode
  stats?: AuthStat[]
  aside?: React.ReactNode
  /** A form with more than a username and a password needs a wider card. */
  wide?: boolean
  children: React.ReactNode
}) {
  /*
    The details have to begin BELOW the card, and the card's height is not
    something CSS here can know.

    In the two-column layout the intro and the card start at the same y. The
    intro is the shorter of the two, so the sections under it began level with
    the MIDDLE of the form — beside it, not below it.

    A fixed offset would be wrong most of the time, because this card changes
    height while you are looking at it: the validation list, the lockout meter,
    the idle-session banner and the OTP step each add or remove rows. So the
    card is measured and its height published as a custom property, which the
    intro takes as a min-height — see .lp-has-details .lp-intro.

    ResizeObserver rather than a one-off measurement, for exactly that reason:
    an error appearing must move the details down with it, not leave them
    overlapping where the card used to end.
  */
  const gridRef = useRef<HTMLDivElement | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const anchorRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const grid = gridRef.current
    const card = cardRef.current
    const anchor = anchorRef.current
    if (!grid || !card || !anchor || typeof ResizeObserver === 'undefined') return

    /*
      --lp-card-h floors the intro, so what follows starts below the form.

      --lp-dx / --lp-dy / --lp-side-w describe where the stages are shown BEFORE
      any scrolling: offset into the right-hand column, under the card, at that
      column's width.

      The stage list is laid out in the LEFT column in the markup — where it ends
      up — and the measurement moves it to its starting place. That direction is
      deliberate: animating it INTO a computed position would make the resting
      layout depend on a measurement, so a bad or missing one would leave the
      page permanently misaligned. This way a failed measurement means no offset,
      and the stages are simply already where they finish.

      One delta for all four, not one each: the gaps between stages are identical
      in both columns, so only the block's origin differs.
    */
    const publish = () => {
      const c = card.getBoundingClientRect()
      grid.style.setProperty('--lp-card-h', `${Math.ceil(c.height)}px`)

      const list = grid.querySelector('.lp-stages')
      if (!list) return
      const a = anchor.getBoundingClientRect()
      const l = list.getBoundingClientRect()
      /* Only while the columns are side by side. Collapsed, the anchor is in the
         same single column as the list and the delta means nothing. */
      const sideBySide = getComputedStyle(grid).gridTemplateColumns.split(' ').length > 1
      grid.style.setProperty('--lp-dx', sideBySide ? `${Math.round(a.left - l.left)}px` : '0px')
      grid.style.setProperty('--lp-dy', sideBySide ? `${Math.round(a.top - l.top)}px` : '0px')
      grid.style.setProperty('--lp-side-w', sideBySide ? `${Math.round(a.width)}px` : 'none')
    }

    publish()
    const ro = new ResizeObserver(publish)
    ro.observe(card)
    ro.observe(grid)
    window.addEventListener('resize', publish)
    return () => { ro.disconnect(); window.removeEventListener('resize', publish) }
  }, [])

  return (
    <>
      <style>{AUTH_CSS}</style>

      <div className="lp-page">
        <header className="lp-nav">
          <div className="lp-in lp-nav-in">
            <a className="lp-brand" href="/" aria-label="IP House">
              <img src="/newlogo.png" alt="IP House" />
            </a>
            <nav className="lp-nav-links">
              <a href="#how">How it works</a>
              <a href="#capabilities">Capabilities</a>
              <a href="mailto:India-itsupport@ip-house.com">Support</a>
            </nav>
          </div>
        </header>

        {/*
          ONE grid for the whole page, not a hero followed by sections.

          The form has to stay put while everything else scrolls, and
          position:sticky is bounded by its containing block — so a card inside a
          hero <section> sticks for the height of the hero and then releases,
          which is indistinguishable from not being sticky at all. The scrolling
          content and the pinned card have to be SIBLINGS in one tall container.

          So the copy, the stats and the aside sections share the left column and
          make the page's height; the card sits in its own right-hand rail and
          pins itself. Below the breakpoint the grid collapses to one column, the
          rail goes back to the top, and nothing is sticky — a form pinned to a
          phone screen is a form covering the page.
        */}
        <main className="lp-main">
          <div ref={gridRef}
            className={`lp-in lp-main-in${wide ? ' is-wide' : ''}${aside ? ' lp-has-details' : ''}`}>
            <div className="lp-col">
              <div className="lp-intro">
                {eyebrow && <span className="lp-eyebrow">{eyebrow}</span>}
                <h1 className="lp-h1">{title}</h1>
                {lede && <p className="lp-lede">{lede}</p>}
                {stats && stats.length > 0 && (
                  <ul className="lp-stats">
                    {stats.map(s => (
                      <li key={s.label}><strong>{s.value}</strong><span>{s.label}</span></li>
                    ))}
                  </ul>
                )}
              </div>

              {aside}
            </div>

            <div className="lp-side">
              <div className="lp-rail">
                <div ref={cardRef} className={`lp-card${wide ? ' is-wide' : ''}`}>
                  {children}
                </div>
              </div>
              {/* Where the stages are shown BEFORE the page is scrolled: in this
                  column, directly below the form. Nothing is drawn — this empty
                  marker exists only so that position can be measured rather than
                  guessed, and it is in normal flow so its top and width are the
                  real ones. */}
              <div ref={anchorRef} className="lp-side-anchor" aria-hidden="true" />
            </div>
          </div>
        </main>

        <footer className="lp-foot">
          <div className="lp-in">
            <div className="lp-foot-in">
              <span>&copy; {new Date().getFullYear()} IP House. All rights reserved.</span>
              <nav>
                <a href="#how">How it works</a>
                <a href="#capabilities">Capabilities</a>
                <a href="mailto:India-itsupport@ip-house.com">Support</a>
              </nav>
            </div>
            <p className="lp-foot-note">
              Confidential &amp; proprietary &mdash; unauthorized access is prohibited.
            </p>
          </div>
        </footer>
      </div>
    </>
  )
}
