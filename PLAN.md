# TikTok Live UI Implementation for Earthseed /scroll View

## Overview

Transform the `/scroll` view to match TikTok Live's visual design while keeping the existing 5-slot QUIC zapping architecture.

## TikTok Live Key UI Elements

### Screen Layout
```
┌─────────────────────────────────┐
│ [LIVE 🔴] [👁 1.2K]        [X] │  ← Top bar
│                                 │
│                                 │
│                           [👤]  │  ← Profile + follow
│                           [❤️]  │  ← Like button
│                           [💬]  │  ← Comments
│                           [🎁]  │  ← Gift
│                           [↗️]  │  ← Share
│                                 │
│ @username ✓                     │  ← Creator info
│ Stream title here...            │
│ [stream_id]                     │
│                                 │
│          ───────                │  ← Swipe indicator
└─────────────────────────────────┘
```

### TikTok Brand Colors
- **Black (Background):** `#000000`
- **TikTok Red/Pink:** `#FE2C55`
- **TikTok Cyan:** `#25F4EE`
- **White (Text/Icons):** `#FFFFFF`

### Typography
- **Font:** System UI (-apple-system, BlinkMacSystemFont)
- **Username:** 16-17px, bold
- **Viewer count:** 13-14px
- **Stream ID:** 13px, monospace, cyan

---

## Implementation Phases

### Phase 1: HTML Structure

Replace the current `.scroll-overlay` content with:

1. **Top Bar**
   - LIVE badge (red, pulsing dot)
   - Viewer count with eye icon
   - Close button (X)

2. **Right Action Bar** (vertical stack)
   - Profile avatar with follow (+) badge
   - Like button (heart)
   - Comment button
   - Gift button
   - Share button

3. **Bottom Left Creator Info**
   - @username with verified badge option
   - Stream title/description
   - Stream ID badge (cyan)

4. **Floating Hearts Container**
   - For like animation effects

5. **Swipe Indicator**
   - Simple horizontal line at bottom

### Phase 2: CSS Styling

Key styles needed:

```css
/* LIVE Badge */
.scroll-live-badge {
  background: #FE2C55;
  padding: 4px 10px;
  border-radius: 4px;
  font-weight: 700;
}

/* Action Buttons */
.scroll-action-bar {
  position: absolute;
  right: 12px;
  bottom: 140px;
  flex-direction: column;
  gap: 20px;
}

/* Profile Avatar */
.scroll-avatar {
  width: 48px;
  height: 48px;
  border: 2px solid #fff;
  border-radius: 50%;
  background: linear-gradient(135deg, #FE2C55, #25F4EE);
}

/* Follow Badge */
.scroll-follow-badge {
  background: #FE2C55;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  position: absolute;
  bottom: -6px;
}

/* Floating Hearts Animation */
@keyframes float-up {
  0% { opacity: 1; transform: translateY(0); }
  100% { opacity: 0; transform: translateY(-180px) scale(0.5); }
}

/* Gradient Overlay */
.scroll-overlay {
  background: linear-gradient(
    to bottom,
    rgba(0, 0, 0, 0.4) 0%,
    transparent 15%,
    transparent 70%,
    rgba(0, 0, 0, 0.6) 100%
  );
}
```

### Phase 3: JavaScript Enhancements

Add to `initScrollView()`:

1. **`updateStreamUI(stream)`** - Update creator name, avatar, stream ID
2. **`spawnFloatingHeart()`** - Create animated heart elements
3. **`setupLikeButton()`** - Handle like taps with animation
4. **`setupDoubleTapLike()`** - Double-tap anywhere to like
5. **`setupCloseButton()`** - Navigate back on close

### Phase 4: Remove Debug Styling

Remove from `.scroll-video-wrapper`:
- Red border
- 50vh height constraint
- Restore full-screen video

---

## Implementation Checklist

### HTML
- [ ] Add LIVE badge with pulsing dot
- [ ] Add viewer count display
- [ ] Add close button
- [ ] Add right-side action bar (profile, like, comment, gift, share)
- [ ] Add creator info section
- [ ] Add floating hearts container
- [ ] Add swipe indicator

### CSS
- [ ] Remove debug styling
- [ ] Add gradient overlay
- [ ] Style LIVE badge
- [ ] Style action buttons
- [ ] Style profile avatar with follow badge
- [ ] Add floating hearts animation
- [ ] Add like pulse animation
- [ ] Support safe-area-inset for notched phones

### JavaScript
- [ ] Add updateStreamUI function
- [ ] Add floating hearts animation
- [ ] Add double-tap to like
- [ ] Wire up close button
- [ ] Update loadCurrentStream to use new UI

---

## Files to Modify

| File | Changes |
|------|---------|
| `index.html` | Replace scroll-overlay HTML (lines ~1524-1547), update CSS (lines ~1193-1421) |
| `src/main.ts` | Add UI handlers in initScrollView (~line 1764+) |

---

## Design References

- TikTok Red: `#FE2C55`
- TikTok Cyan: `#25F4EE`
- Background gradients for text readability
- 48px touch targets for action buttons
- Safe area insets for iPhone notch
