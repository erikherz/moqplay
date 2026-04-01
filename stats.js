/* stats.js — Optional stats overlay for MoQplay.
 * Press 'I' to toggle. Auto-attaches to any MoqtPlayer instance.
 * Include after moqt-player.js:
 *   <script src="https://moqplay.com/js/stats.js"></script>
 */
(function() {
  let overlay = null;
  let interval = null;
  let startTime = null;

  function findPlayer() {
    if (window._moqplayStats_player) return window._moqplayStats_player;
    if (window.player && window.player.getStats) return window.player;
    if (window.moqPlayer && window.moqPlayer.getStats) return window.moqPlayer;
    // Last resort: find any MoqtPlayer instance registered on window
    if (window.MoqtPlayer && window.MoqtPlayer._lastInstance) return window.MoqtPlayer._lastInstance;
    return null;
  }

  // Allow explicit registration
  window.MoqplayStats = {
    attach: function(player) {
      window._moqplayStats_player = player;
      if (!startTime) startTime = Date.now();
    }
  };

  function createOverlay() {
    overlay = document.createElement('div');
    overlay.id = 'moqplay-stats';
    overlay.style.cssText = 'display:none;position:fixed;top:0;left:0;z-index:99999;background:rgba(0,0,0,0.88);padding:14px 18px;font-family:"SF Mono","Roboto Mono",monospace;font-size:12px;line-height:1.7;color:#e5e5e5;min-width:280px;pointer-events:none;border-bottom-right-radius:8px;';
    overlay.innerHTML = '<div style="font-weight:700;margin-bottom:4px;">MoQplay</div><div id="moqplay-stats-body"></div>';
    document.body.appendChild(overlay);
  }

  function row(label, value) {
    return '<div style="display:flex;justify-content:space-between;gap:24px;"><span style="color:#888;">' + label + '</span><span>' + value + '</span></div>';
  }

  function update() {
    if (!overlay || overlay.style.display === 'none') return;
    var player = findPlayer();
    if (!player) {
      document.getElementById('moqplay-stats-body').innerHTML = '<span style="color:#888;">No player found</span>';
      return;
    }

    if (!startTime) startTime = Date.now();
    var s = player.getStats();
    var t = player.getTiming ? player.getTiming() : {};
    var video = player.video;
    var transport = player.transportType === 'websocket' ? 'WebSocket' : 'WebTransport';
    var uptime = Math.floor((Date.now() - startTime) / 1000);
    var fps = '?';
    var dropped = 0;
    if (video && video.getVideoPlaybackQuality) {
      var q = video.getVideoPlaybackQuality();
      fps = uptime > 0 ? Math.round(q.totalVideoFrames / uptime) : '?';
      dropped = q.droppedVideoFrames || 0;
    }

    var html = [
      row('Transport', 'MoQT / ' + transport + ' / CMSF'),
      row('Relay', (player.relayUrl || '-').replace('https://', '')),
      row('', ''),
      row('Framerate', fps + ' fps'),
      row('Dropped Frames', dropped),
      row('Buffer Health', (s.bufferHealth || '0.00') + 's'),
      row('Target Latency', (s.targetLatency || '-') + 'ms'),
      row('Session', uptime + 's'),
      row('Stale Drops', 'V:' + (s.droppedStaleVideo || 0) + ' A:' + (s.droppedStaleAudio || 0)),
      row('', ''),
      row('ABR Ladder', s.abrLadder || '-'),
      row('Current Track', s.abrCurrentResolution || '-'),
      row('ABR Switches', s.abrSwitchCount != null ? s.abrSwitchCount : 0),
      row('', ''),
    ];

    if (t.setupMs != null) html.push(row('SETUP', t.setupMs + 'ms'));
    if (t.catalogMs != null) html.push(row('Catalog', t.catalogMs + 'ms'));
    if (t.firstFragmentMs != null) html.push(row('1st Fragment', t.firstFragmentMs + 'ms'));
    if (t.firstDecodedMs != null) html.push(row('TTFF', t.firstDecodedMs + 'ms'));

    document.getElementById('moqplay-stats-body').innerHTML = html.join('');
  }

  document.addEventListener('keydown', function(e) {
    if (e.key === 'i' || e.key === 'I') {
      if (!overlay) createOverlay();
      overlay.style.display = overlay.style.display === 'none' ? 'block' : 'none';
      if (overlay.style.display === 'block' && !interval) {
        interval = setInterval(update, 500);
      }
      if (overlay.style.display === 'none' && interval) {
        clearInterval(interval);
        interval = null;
      }
    }
  });
})();
