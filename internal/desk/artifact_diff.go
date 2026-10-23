package desk

import "errors"

const (
	// The preview renders every returned patch; keep the response bounded for
	// long conversations and very large edits.
	maxArtifactDiffBytes   = 256 << 10
	maxArtifactDiffChanges = 32
	maxArtifactChangeBytes = 128 << 10
)

// ArtifactChange is one original write/edit of a file, newest last.
type ArtifactChange struct {
	Patch     string `json:"patch"`
	Additions int    `json:"additions,omitempty"`
	Deletions int    `json:"deletions,omitempty"`
	Truncated bool   `json:"truncated,omitempty"`
}

// ArtifactDiff lists the recorded changes for one artifact.
type ArtifactDiff struct {
	Changes   []ArtifactChange `json:"changes"`
	Truncated bool             `json:"truncated,omitempty"`
}

// DiffArtifact returns the readable patches for a file produced by this
// conversation. Patches come from the same original successful calls that
// build the artifact list, so failed, replayed and out-of-workspace operations
// never leak a diff.
func (s *Service) DiffArtifact(id, path string) (ArtifactDiff, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.conversationIdleLocked(id); err != nil {
		return ArtifactDiff{}, err
	}
	if path == "" {
		return ArtifactDiff{}, errors.New("Choose a file produced by this conversation")
	}
	records, err := s.artifactRecordsLocked(id)
	if err != nil {
		return ArtifactDiff{}, err
	}
	diff := ArtifactDiff{Changes: []ArtifactChange{}}
	found, total := false, 0
	for _, record := range records {
		if record.path != path {
			continue
		}
		found = true
		if record.patch == "" {
			continue
		}
		if len(diff.Changes) >= maxArtifactDiffChanges || total >= maxArtifactDiffBytes {
			diff.Truncated = true
			break
		}
		patch, truncated := record.patch, record.patchTruncated
		if len(patch) > maxArtifactChangeBytes {
			patch, truncated = clipUTF8(patch, maxArtifactChangeBytes), true
		}
		if remaining := maxArtifactDiffBytes - total; len(patch) > remaining {
			patch, truncated, diff.Truncated = clipUTF8(patch, remaining), true, true
		}
		diff.Changes = append(diff.Changes, ArtifactChange{
			Patch:     patch,
			Additions: record.additions,
			Deletions: record.deletions,
			Truncated: truncated,
		})
		total += len(patch)
		if diff.Truncated {
			break
		}
	}
	if !found {
		return ArtifactDiff{}, errors.New("Show changes for a file produced by this conversation inside its workspace")
	}
	return diff, nil
}
