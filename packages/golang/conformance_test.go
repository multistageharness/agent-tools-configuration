package configdiscovery

import (
	"os/exec"
	"path/filepath"
	"testing"
)

// The cross-language conformance suite, run as part of this package's own tests. A conformance
// regression should fail `go test`, not only CI.
func TestConformanceSuite(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("the conformance runner needs node")
	}
	repoRoot, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("node", filepath.Join(repoRoot, "packages/spec/runner/run.mjs"), "--probe", "golang")
	cmd.Dir = repoRoot
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("conformance suite failed: %v\n%s", err, output)
	}
}
