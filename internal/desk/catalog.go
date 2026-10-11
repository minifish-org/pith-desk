package desk

import (
	"errors"
	"github.com/minifish-org/pith-desk/internal/localstore"
)

// Catalog is the single owner of index state. Service.mu serializes its use;
// sessions retain authority over message bodies, branches and title history.
type Catalog struct {
	catalogState
	path string
}

func (c *Catalog) restore(files localstore.Store) (catalogState, error) {
	var saved catalogState
	if err := files.ReadJSON(c.path, &saved); err != nil {
		return catalogState{}, err
	}
	if saved.Workspaces != nil {
		c.Workspaces = saved.Workspaces
	}
	if saved.Conversations != nil {
		c.Conversations = saved.Conversations
		for i := range c.Conversations {
			c.Conversations[i].PermissionMode = normalizedPermissionMode(c.Conversations[i].PermissionMode)
		}
	}
	c.ActiveID = saved.ActiveID
	return saved, nil
}

func (c *Catalog) persist(files localstore.Store) error {
	return files.WriteJSON(c.path, c.catalogState)
}

// replace follows an already committed catalog write; it makes no other files
// authoritative and deliberately does not hide partial success from callers.
func (c *Catalog) replace(next catalogState) { c.catalogState = next }

func (c *Catalog) workspace(id string) (Workspace, bool) {
	for _, workspace := range c.Workspaces {
		if workspace.ID == id {
			return workspace, true
		}
	}
	return Workspace{}, false
}

func (c *Catalog) conversationIndex(id string) int {
	for i := range c.Conversations {
		if c.Conversations[i].ID == id {
			return i
		}
	}
	return -1
}

func (c *Catalog) selectConversation(id string) { c.ActiveID = id }

func (c *Catalog) addWorkspace(workspace Workspace, files localstore.Store) error {
	c.Workspaces = append(c.Workspaces, workspace)
	if err := c.persist(files); err != nil {
		c.Workspaces = c.Workspaces[:len(c.Workspaces)-1]
		return err
	}
	return nil
}

func (c *Catalog) createConversation(conversation Conversation, files localstore.Store) error {
	previous := c.ActiveID
	c.Conversations = append(c.Conversations, conversation)
	c.ActiveID = conversation.ID
	if err := c.persist(files); err != nil {
		c.Conversations = c.Conversations[:len(c.Conversations)-1]
		c.ActiveID = previous
		return err
	}
	return nil
}

// update rolls back an index-only operation if its catalog write fails.
// Session commits instead use rememberTitle/touch followed by persist, since
// their canonical title has already been saved and must remain visible.
func (c *Catalog) update(index int, next Conversation, files localstore.Store) error {
	previous := c.Conversations[index]
	c.Conversations[index] = next
	if err := c.persist(files); err != nil {
		c.Conversations[index] = previous
		return err
	}
	return nil
}

func (c *Catalog) rememberTitle(index int, title string) { c.Conversations[index].Title = title }
func (c *Catalog) touch(index int, at string)            { c.Conversations[index].UpdatedAt = at }

func (c *Catalog) setPermission(id string, mode PermissionMode, files localstore.Store) error {
	index := c.conversationIndex(id)
	if index < 0 {
		return errors.New("Conversation not found")
	}
	next := c.Conversations[index]
	next.PermissionMode = mode
	return c.update(index, next, files)
}

func (c *Catalog) complete(id, runID string, files localstore.Store) error {
	index := c.conversationIndex(id)
	if index < 0 || runID == "" {
		return nil
	}
	next := c.Conversations[index]
	next.CompletedRunID, next.Unread = runID, true
	return c.update(index, next, files)
}

func (c *Catalog) markRead(id, runID string, files localstore.Store) (bool, error) {
	index := c.conversationIndex(id)
	if index < 0 {
		return false, errors.New("Conversation not found")
	}
	next := c.Conversations[index]
	if runID == "" || next.CompletedRunID != runID || !next.Unread {
		return false, nil
	}
	next.Unread = false
	if err := c.update(index, next, files); err != nil {
		return false, err
	}
	return true, nil
}

func (c *Catalog) without(workspaceID string, removed map[string]bool) catalogState {
	next := catalogState{Workspaces: []Workspace{}, Conversations: []Conversation{}, ActiveID: c.ActiveID}
	for _, workspace := range c.Workspaces {
		if workspace.ID != workspaceID {
			next.Workspaces = append(next.Workspaces, workspace)
		}
	}
	for _, conversation := range c.Conversations {
		if !removed[conversation.ID] {
			next.Conversations = append(next.Conversations, conversation)
		}
	}
	if removed[next.ActiveID] {
		next.ActiveID = ""
	}
	return next
}
