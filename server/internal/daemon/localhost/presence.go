package localhost

// Presence tells a scope's connections which other devices use each of its
// conversations: a remote device counts while it has the conversation open
// or a turn it started is running.

func presenceMessage(conversationID string, devices []map[string]string) map[string]any {
	return map[string]any{"version": V2Version, "type": "scope.presence", "conversation_id": conversationID, "devices": devices}
}

// devicesFor lists the devices using a conversation, leaving out the
// receiving client; v.mu is held.
func (v *V2) devicesFor(scopeID int64, conversationID, receiver string) []map[string]string {
	devices := []map[string]string{}
	seen := map[string]bool{}
	for key, peer := range v.presence[scopeID][conversationID] {
		if key == receiver || key == runKey+receiver || seen[peer.ID] {
			continue
		}
		seen[peer.ID] = true
		devices = append(devices, map[string]string{"peer_id": peer.ID, "device_name": peer.DeviceName})
	}
	return devices
}

// setPresence records that c opened or closed a conversation.
func (v *V2) setPresence(c *wsConn, conversationID string, open bool) {
	if c.caller.kind != callerRemote || c.caller.clientKey == "" {
		return
	}
	v.mark(c.scopeID, conversationID, c.caller.clientKey, c.caller, open)
}

// runKey marks a turn a remote client started, which keeps its device
// using the conversation until the turn ends even with the page closed.
const runKey = "run/"

// startedRun records, or withdraws, a turn another device starts in a
// conversation.
func (v *V2) startedRun(scopeID int64, conversationID string, c caller, started bool) {
	if c.kind != callerRemote || c.clientKey == "" {
		return
	}
	v.mark(scopeID, conversationID, runKey+c.clientKey, c, started)
}

// turnEnded clears the runs other devices started in the conversation.
func (v *V2) turnEnded(conversationID string) {
	type run struct {
		scopeID int64
		key     string
	}
	var ended []run
	v.mu.Lock()
	for scopeID, byConv := range v.presence {
		for key := range byConv[conversationID] {
			if len(key) > len(runKey) && key[:len(runKey)] == runKey {
				ended = append(ended, run{scopeID, key})
			}
		}
	}
	v.mu.Unlock()
	for _, r := range ended {
		v.mark(r.scopeID, conversationID, r.key, caller{}, false)
	}
}

// mark records whether key uses a conversation and tells the scope's
// connections when the devices using it changed.
func (v *V2) mark(scopeID int64, conversationID, key string, c caller, open bool) {
	// Listed before taking v.mu: hosts.mu is taken before v.mu elsewhere.
	receivers := v.scopeListeners(scopeID)
	v.mu.Lock()
	byConv := v.presence[scopeID]
	if byConv == nil {
		byConv = map[string]map[string]RemotePeer{}
		v.presence[scopeID] = byConv
	}
	clients := byConv[conversationID]
	_, had := clients[key]
	if open == had {
		v.mu.Unlock()
		return
	}
	if open {
		if clients == nil {
			clients = map[string]RemotePeer{}
			byConv[conversationID] = clients
		}
		clients[key] = RemotePeer{ID: c.peer, DeviceName: c.deviceName}
	} else {
		delete(clients, key)
		if len(clients) == 0 {
			delete(byConv, conversationID)
		}
	}
	messages := make([]map[string]any, len(receivers))
	for i, r := range receivers {
		messages[i] = presenceMessage(conversationID, v.devicesFor(scopeID, conversationID, r.caller.clientKey))
	}
	v.mu.Unlock()
	for i, r := range receivers {
		_ = r.send(messages[i])
	}
}

// sendPresence gives a new scope subscription every conversation in use.
func (v *V2) sendPresence(c *wsConn) {
	v.mu.Lock()
	var messages []map[string]any
	for id := range v.presence[c.scopeID] {
		if devices := v.devicesFor(c.scopeID, id, c.caller.clientKey); len(devices) > 0 {
			messages = append(messages, presenceMessage(id, devices))
		}
	}
	v.mu.Unlock()
	for _, m := range messages {
		_ = c.send(m)
	}
}

// scopeListeners are the scope's connections that follow its list.
func (v *V2) scopeListeners(scopeID int64) []*wsConn {
	v.hosts.mu.Lock()
	conns := append([]*wsConn(nil), v.hosts.byScope[scopeID]...)
	v.hosts.mu.Unlock()
	out := conns[:0]
	for _, c := range conns {
		c.mu.Lock()
		following := c.scope != nil
		c.mu.Unlock()
		if following {
			out = append(out, c)
		}
	}
	return out
}
