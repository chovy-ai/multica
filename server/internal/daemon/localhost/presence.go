package localhost

// Presence tells a scope's connections which other devices use each of its
// conversations: a remote device counts while it has the conversation open.

func presenceMessage(conversationID string, devices []map[string]string) map[string]any {
	return map[string]any{"version": V2Version, "type": "scope.presence", "conversation_id": conversationID, "devices": devices}
}

// devicesFor lists the devices using a conversation, leaving out the
// receiving client; v.mu is held.
func (v *V2) devicesFor(scopeID int64, conversationID, receiver string) []map[string]string {
	devices := []map[string]string{}
	seen := map[string]bool{}
	for key, peer := range v.presence[scopeID][conversationID] {
		if key == receiver || seen[peer.ID] {
			continue
		}
		seen[peer.ID] = true
		devices = append(devices, map[string]string{"peer_id": peer.ID, "device_name": peer.DeviceName})
	}
	return devices
}

// setPresence records that c opened or closed a conversation and tells the
// scope's other connections when the devices using it changed.
func (v *V2) setPresence(c *wsConn, conversationID string, open bool) {
	if c.caller.kind != callerRemote || c.caller.clientKey == "" {
		return
	}
	// Listed before taking v.mu: hosts.mu is taken before v.mu elsewhere.
	receivers := v.scopeListeners(c.scopeID)
	v.mu.Lock()
	byConv := v.presence[c.scopeID]
	if byConv == nil {
		byConv = map[string]map[string]RemotePeer{}
		v.presence[c.scopeID] = byConv
	}
	clients := byConv[conversationID]
	_, had := clients[c.caller.clientKey]
	if open == had {
		v.mu.Unlock()
		return
	}
	if open {
		if clients == nil {
			clients = map[string]RemotePeer{}
			byConv[conversationID] = clients
		}
		clients[c.caller.clientKey] = RemotePeer{ID: c.caller.peer, DeviceName: c.caller.deviceName}
	} else {
		delete(clients, c.caller.clientKey)
		if len(clients) == 0 {
			delete(byConv, conversationID)
		}
	}
	messages := make([]map[string]any, len(receivers))
	for i, r := range receivers {
		messages[i] = presenceMessage(conversationID, v.devicesFor(c.scopeID, conversationID, r.caller.clientKey))
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
