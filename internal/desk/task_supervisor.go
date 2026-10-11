package desk

import (
	"context"
	"errors"
	"github.com/minifish-org/pith-desk/internal/workspacefs"
	"sync"
)

// TaskSupervisor owns the runtime registry and admission occupancy. It does
// not own Catalog selection; Service chooses which registered view to display.
// A running entry stays occupied through settlement and resource cleanup.
// The caller holds the application mutex for all registry access.
type TaskSupervisor struct {
	runs map[string]*RunExecution
}

func (t *TaskSupervisor) register(r *RunExecution) {
	if r.id != "" {
		t.runs[r.id] = r
	}
}
func (t *TaskSupervisor) remove(id string) { delete(t.runs, id) }
func (t *TaskSupervisor) anyRunning() bool {
	for _, r := range t.runs {
		if r.Running {
			return true
		}
	}
	return false
}
func (t *TaskSupervisor) workspaceIdle(w Workspace) error {
	for _, r := range t.runs {
		if r.Running && (workspacefs.Within(w.Path, r.workspace.Path) || workspacefs.Within(r.workspace.Path, w.Path)) {
			return errors.New("A task is already running in this workspace or an overlapping folder. Open that conversation or wait for it to finish")
		}
	}
	return nil
}
func (t *TaskSupervisor) conversationIdle(id string) error {
	if r := t.runs[id]; r != nil && r.Running {
		return errors.New("Stop this conversation's task before changing its history")
	}
	return nil
}
func (t *TaskSupervisor) snapshotTasks() map[string]snapshotTask {
	tasks := make(map[string]snapshotTask, len(t.runs))
	for id, r := range t.runs {
		if r == nil {
			continue
		}
		tasks[id] = snapshotTask{conversationID: r.id, workspaceID: r.workspace.ID, phase: r.Runtime.Phase, running: r.Running, needsApproval: r.PendingApproval != nil}
	}
	return tasks
}

type closingTask struct {
	journal *deskDurable
	done    chan struct{}
}

func (t *TaskSupervisor) prepareClose() []closingTask {
	var runs []closingTask
	for _, r := range t.runs {
		if r.Running {
			runs = append(runs, closingTask{r.durable, r.runDone})
			r.clearQueueLocked()
			r.queueClosing = true
		}
	}
	return runs
}

// Cancel every harness before waiting for any one. Close preserves uncertain
// tasks for reviewed recovery; explicit Abort settles them as stopped.
func closeTasks(runs []closingTask) {
	var workers sync.WaitGroup
	for _, r := range runs {
		workers.Add(1)
		go func() { defer workers.Done(); _ = r.journal.harness.Close(context.Background()) }()
	}
	workers.Wait()
	for _, r := range runs {
		<-r.done
	}
}

func newTaskSupervisor() TaskSupervisor                  { return TaskSupervisor{runs: map[string]*RunExecution{}} }
func (t *TaskSupervisor) lookup(id string) *RunExecution { return t.runs[id] }
func (t *TaskSupervisor) pendingApproval(id string) *RunExecution {
	for _, r := range t.runs {
		if r.PendingApproval != nil && r.PendingApproval.ID == id {
			return r
		}
	}
	return nil
}
