package configdiscovery

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// tree materializes {relative path: contents} under t.TempDir() and returns the root, resolved
// so comparisons against the walk's output line up on macOS where /var is a symlink.
//
// Every test here builds its own tree and injects cwd and home. Nothing reads the real working
// directory or the real home: a suite whose results depend on the machine is not a suite.
func tree(t *testing.T, files map[string]string) string {
	t.Helper()
	root := t.TempDir()
	for relative, contents := range files {
		target := filepath.Join(root, relative)
		if strings.HasSuffix(relative, "/") {
			if err := os.MkdirAll(target, 0o755); err != nil {
				t.Fatal(err)
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(target, []byte(contents), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	resolved, err := filepath.EvalSymlinks(root)
	if err != nil {
		t.Fatal(err)
	}
	return resolved
}

func TestResolveProjectRootsFindsAConfigTwoLevelsUp(t *testing.T) {
	root := tree(t, map[string]string{
		".git":                       "",
		".config/mytool/config.toml": "a = 1\n",
		"a/b/":                       "",
	})
	got, err := resolveProjectRoots(filepath.Join(root, "a/b"), "mytool", walkOptions{})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{filepath.Join(root, ".config/mytool")}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestResolveProjectRootsOrdersFarthestAncestorFirst(t *testing.T) {
	root := tree(t, map[string]string{
		".git":                           "",
		".config/mytool/config.toml":     "a = 1\n",
		"pkg/.config/mytool/config.toml": "a = 2\n",
		"pkg/src/":                       "",
	})
	got, err := resolveProjectRoots(filepath.Join(root, "pkg/src"), "mytool", walkOptions{})
	if err != nil {
		t.Fatal(err)
	}
	// Order is the contract: the nearest root is last, and last is what wins.
	want := []string{
		filepath.Join(root, ".config/mytool"),
		filepath.Join(root, "pkg/.config/mytool"),
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestResolveProjectRootsStopsAtAGitDirectory(t *testing.T) {
	root := tree(t, map[string]string{
		".config/mytool/config.toml": "a = 1\n",
		"repo/.git/HEAD":             "ref: refs/heads/main\n",
		"repo/pkg/":                  "",
	})
	got, err := resolveProjectRoots(filepath.Join(root, "repo/pkg"), "mytool", walkOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("expected the walk to stop before the config, got %v", got)
	}
}

func TestResolveProjectRootsStopsAtAGitFile(t *testing.T) {
	// The form git writes for a linked worktree or a submodule. Those are repositories too, and
	// a walk that only tests for a directory climbs straight past them.
	root := tree(t, map[string]string{
		".config/mytool/config.toml": "a = 1\n",
		"repo/.git":                  "gitdir: /elsewhere/.git/worktrees/w\n",
		"repo/pkg/":                  "",
	})
	got, err := resolveProjectRoots(filepath.Join(root, "repo/pkg"), "mytool", walkOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("expected the walk to stop before the config, got %v", got)
	}
}

func TestResolveProjectRootsStopDirIsInclusive(t *testing.T) {
	root := tree(t, map[string]string{
		".git":                           "",
		"pkg/.config/mytool/config.toml": "a = 1\n",
		"pkg/src/":                       "",
	})
	got, err := resolveProjectRoots(
		filepath.Join(root, "pkg/src"), "mytool", walkOptions{stopDir: filepath.Join(root, "pkg")},
	)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{filepath.Join(root, "pkg/.config/mytool")}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestResolveProjectRootsHomeIsInclusive(t *testing.T) {
	root := tree(t, map[string]string{
		".git":                            "",
		"home/.config/mytool/config.toml": "a = 1\n",
		"home/work/":                      "",
	})
	got, err := resolveProjectRoots(
		filepath.Join(root, "home/work"), "mytool", walkOptions{home: filepath.Join(root, "home")},
	)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{filepath.Join(root, "home/.config/mytool")}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestResolveProjectRootsDepthCap(t *testing.T) {
	root := t.TempDir()
	deep := root
	for i := 0; i < 70; i++ {
		deep = filepath.Join(deep, "d")
	}
	if err := os.MkdirAll(deep, 0o755); err != nil {
		t.Fatal(err)
	}
	_, err := resolveProjectRoots(deep, "mytool", walkOptions{})
	if err == nil || !strings.Contains(err.Error(), "exceeded 64 directories") {
		t.Fatalf("expected the depth cap to fire, got %v", err)
	}
}

func TestResolveUserRoot(t *testing.T) {
	root := tree(t, map[string]string{
		"xdg/mytool/config.toml":          "a = 1\n",
		"home/.config/mytool/config.toml": "a = 2\n",
		"emptyhome/":                      "",
	})

	cases := []struct {
		name        string
		home        string
		env         map[string]string
		want        string
		wantWarning bool
	}{
		{
			name: "an absolute XDG_CONFIG_HOME wins",
			home: filepath.Join(root, "home"),
			env:  map[string]string{"XDG_CONFIG_HOME": filepath.Join(root, "xdg")},
			want: filepath.Join(root, "xdg/mytool"),
		},
		{
			name:        "a relative XDG_CONFIG_HOME is ignored and warns",
			home:        filepath.Join(root, "home"),
			env:         map[string]string{"XDG_CONFIG_HOME": "../cfg"},
			want:        filepath.Join(root, "home/.config/mytool"),
			wantWarning: true,
		},
		{
			name:        "an empty XDG_CONFIG_HOME is ignored and warns",
			home:        filepath.Join(root, "home"),
			env:         map[string]string{"XDG_CONFIG_HOME": ""},
			want:        filepath.Join(root, "home/.config/mytool"),
			wantWarning: true,
		},
		{
			name: "unset XDG_CONFIG_HOME uses home/.config",
			home: filepath.Join(root, "home"),
			env:  map[string]string{},
			want: filepath.Join(root, "home/.config/mytool"),
		},
		{
			name: "a missing directory is no user root at all",
			home: filepath.Join(root, "emptyhome"),
			env:  map[string]string{},
			want: "",
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			var warnings []string
			got := resolveUserRoot("mytool", testCase.home, testCase.env, func(message string) {
				warnings = append(warnings, message)
			})
			if got != testCase.want {
				t.Fatalf("got %q, want %q", got, testCase.want)
			}
			if testCase.wantWarning && len(warnings) != 1 {
				t.Fatalf("expected exactly one warning, got %v", warnings)
			}
			if !testCase.wantWarning && len(warnings) != 0 {
				t.Fatalf("expected no warning, got %v", warnings)
			}
		})
	}
}
