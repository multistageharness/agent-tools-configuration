package configdiscovery

// Search-path resolution - SPEC section 2.
//
// Viper's AddConfigPath searches a flat list of directories and stops at the first match; it
// never walks upward, and it cannot express "collect every ancestor and layer them". So the walk
// is entirely ours, in every language, and this file is the Go half of keeping those five
// hand-written walks identical.

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// maxDepth guards against a pathological mount or an uncollapsed symlink loop. No real tree is
// 64 directories deep below its repository root.
const maxDepth = 64

type walkOptions struct {
	home    string
	stopDir string
}

func isDir(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

// resolveProjectRoots returns every existing .config/<packageName>/ from cwd upward, farthest
// ancestor first - the SPEC section 2.7 order, so the nearest root is last and therefore wins.
func resolveProjectRoots(cwd, packageName string, o walkOptions) ([]string, error) {
	// SPEC section 2.1: resolved exactly once. A failure here is reported rather than papered
	// over, because silently walking an unresolved path would search the wrong ancestors.
	dir, err := filepath.EvalSymlinks(cwd)
	if err != nil {
		return nil, &ConfigError{Kind: KindUnreadable, Path: cwd, Message: err.Error(), Err: err}
	}

	home := resolveOrRaw(o.home)
	stopDir := resolveOrRaw(o.stopDir)

	var roots []string
	for depth := 0; ; depth++ {
		if depth > maxDepth {
			return nil, &ConfigError{
				Kind:    KindUnreadable,
				Path:    cwd,
				Message: fmt.Sprintf("upward walk exceeded %d directories", maxDepth),
			}
		}

		// SPEC section 2.2: a directory is checked before it is tested for stopping, so a config
		// beside a .git is found and the walk then ends.
		if candidate := filepath.Join(dir, ".config", packageName); isDir(candidate) {
			roots = append(roots, candidate)
		}

		parent := filepath.Dir(dir)
		atFilesystemRoot := parent == dir
		atHome := home != "" && dir == home
		atStopDir := stopDir != "" && dir == stopDir
		// Lstat, and both forms count: a directory in a normal clone, a file in a worktree or a
		// submodule. Those are repositories too.
		_, gitErr := os.Lstat(filepath.Join(dir, ".git"))
		atRepositoryBoundary := gitErr == nil

		if atFilesystemRoot || atHome || atStopDir || atRepositoryBoundary {
			break
		}
		dir = parent
	}

	for i, j := 0, len(roots)-1; i < j; i, j = i+1, j-1 {
		roots[i], roots[j] = roots[j], roots[i]
	}
	return roots, nil
}

// resolveOrRaw resolves symlinks when it can and falls back to the input otherwise, so a stop
// directory that does not exist yet still compares against the walk by name.
func resolveOrRaw(path string) string {
	if path == "" {
		return ""
	}
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		return resolved
	}
	return filepath.Clean(path)
}

// resolveUserRoot returns the single user-level root of SPEC section 2.4, or "" when there is
// none - so a caller can tell "no user config at all" from "the user config directory is empty".
//
// Windows takes this identical path. %APPDATA% and %LOCALAPPDATA% are deliberately not consulted
// (SPEC section 2.4): the same directory has to be readable by five language implementations,
// and one documented location beats a native one nobody can predict.
func resolveUserRoot(packageName, home string, env map[string]string, warn func(string)) string {
	var root string
	xdg, set := env["XDG_CONFIG_HOME"]
	if set && xdg != "" && filepath.IsAbs(xdg) {
		root = filepath.Join(xdg, packageName)
	} else {
		if set {
			warn(fmt.Sprintf(
				"ignoring XDG_CONFIG_HOME=%q: it must be a non-empty absolute path (SPEC section 2.4)",
				xdg,
			))
		}
		root = filepath.Join(home, ".config", packageName)
	}
	if !isDir(root) {
		return ""
	}
	return root
}

type fileRef struct {
	path   string
	format string
}

// recognizedFiles is the closed, ordered list of SPEC section 2.5. That order is also the load
// order within one directory, later entries winning.
var recognizedFiles = []fileRef{
	{"config.toml", "toml"},
	{"config.yaml", "yaml"},
	{"config.yml", "yaml"},
	{"config.json", "json"},
	{"config.jsonc", "jsonc"},
	{"config.ini", "ini"},
	{".env", "dotenv"},
}

func exists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}

// listConfigFiles returns the recognized files present in one config directory, in SPEC section
// 2.5 order.
func listConfigFiles(root, profile string) ([]fileRef, error) {
	// SPEC section 2.5: a mistake, not an intention. Picking a winner silently would hide it.
	if exists(filepath.Join(root, "config.yaml")) && exists(filepath.Join(root, "config.yml")) {
		return nil, &ConfigError{
			Kind:    KindDuplicateFormat,
			Path:    root,
			Message: "config.yaml and config.yml cannot both be present",
		}
	}

	var files []fileRef
	for _, candidate := range recognizedFiles {
		path := filepath.Join(root, candidate.name())
		if exists(path) {
			files = append(files, fileRef{path: path, format: candidate.format})
		}
		if profile != "" {
			// SPEC section 2.6: config.<profile>.<ext> immediately after its base file.
			profiled := filepath.Join(root, withProfile(candidate.name(), profile))
			if exists(profiled) {
				files = append(files, fileRef{path: profiled, format: candidate.format})
			}
		}
	}
	return files, nil
}

// name is the base file name for an entry of recognizedFiles, where path holds the name rather
// than a full path.
func (f fileRef) name() string { return f.path }

func withProfile(name, profile string) string {
	dot := strings.LastIndex(name, ".")
	if dot <= 0 {
		return name + "." + profile
	}
	return name[:dot] + "." + profile + name[dot:]
}
