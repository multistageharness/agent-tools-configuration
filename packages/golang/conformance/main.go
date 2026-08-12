// Command probe is the adapter between packages/spec/PROBE.md and this package's Load.
//
// Small, and every rule in it exists because breaking it makes fixtures fail for reasons that
// have nothing to do with the library.
package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime/debug"
	"strings"

	configdiscovery "github.com/multistageharness/agent-tools-configuration/packages/golang"
)

type repeatable []string

func (r *repeatable) String() string { return strings.Join(*r, ",") }

func (r *repeatable) Set(value string) error {
	*r = append(*r, value)
	return nil
}

// knownOptions is SPEC section 6. Anything outside this set exits 2 rather than being quietly
// ignored: a probe that shrugs off arrayMerge and still prints a result claims conformance it
// does not have.
var knownOptions = map[string]bool{
	"strategy": true, "arrayMerge": true, "stopDir": true, "envPrefix": true,
	"profile": true, "strict": true, "defaults": true, "overrides": true,
}

type probeOptions struct {
	Strategy   *string        `json:"strategy"`
	ArrayMerge *string        `json:"arrayMerge"`
	StopDir    *string        `json:"stopDir"`
	EnvPrefix  *string        `json:"envPrefix"`
	Profile    *string        `json:"profile"`
	Strict     *bool          `json:"strict"`
	Defaults   map[string]any `json:"defaults"`
	Overrides  map[string]any `json:"overrides"`
}

func main() {
	os.Exit(run())
}

func run() (code int) {
	// A panic is this harness breaking, not the library rejecting input: exit 2, so the runner
	// reports the case as unproven rather than as a conformance failure.
	defer func() {
		if recovered := recover(); recovered != nil {
			fmt.Fprintf(os.Stderr, "probe panicked: %v\n%s\n", recovered, debug.Stack())
			code = 2
		}
	}()

	flags := flag.NewFlagSet("probe", flag.ContinueOnError)
	flags.SetOutput(os.Stderr) // Usage text is a diagnostic; stdout belongs to the JSON alone.
	packageName := flags.String("package-name", "", "")
	cwd := flags.String("cwd", "", "")
	home := flags.String("home", "", "")
	fixtureRoot := flags.String("fixture-root", "", "")
	optionsJSON := flags.String("options", "{}", "")
	var envPairs repeatable
	flags.Var(&envPairs, "env", "")

	if err := flags.Parse(os.Args[1:]); err != nil {
		return 2
	}
	for _, required := range []struct {
		name  string
		value *string
	}{{"--package-name", packageName}, {"--cwd", cwd}, {"--home", home}, {"--fixture-root", fixtureRoot}} {
		if *required.value == "" {
			fmt.Fprintf(os.Stderr, "missing required flag %s\n", required.name)
			return 2
		}
	}

	// Built only from --env. Never os.Environ(): this is the line that stops a developer's
	// exported MYTOOL_LOG__LEVEL from silently changing fixture results.
	env := map[string]string{}
	for _, pair := range envPairs {
		name, value, found := strings.Cut(pair, "=")
		if !found || name == "" {
			fmt.Fprintf(os.Stderr, "--env expects KEY=VALUE, got %q\n", pair)
			return 2
		}
		env[name] = value
	}

	var raw map[string]json.RawMessage
	if err := json.Unmarshal([]byte(*optionsJSON), &raw); err != nil {
		fmt.Fprintf(os.Stderr, "--options is not valid JSON: %v\n", err)
		return 2
	}
	for name := range raw {
		if !knownOptions[name] {
			fmt.Fprintf(os.Stderr, "unsupported option %q (SPEC section 6)\n", name)
			return 2
		}
	}
	var parsed probeOptions
	if err := json.Unmarshal([]byte(*optionsJSON), &parsed); err != nil {
		fmt.Fprintf(os.Stderr, "--options has the wrong shape: %v\n", err)
		return 2
	}

	root, err := filepath.Abs(*fixtureRoot)
	if err != nil {
		fmt.Fprintf(os.Stderr, "bad --fixture-root: %v\n", err)
		return 2
	}

	opts := []configdiscovery.Option{
		configdiscovery.WithCwd(*cwd),
		configdiscovery.WithHome(*home),
		configdiscovery.WithEnv(env),
		configdiscovery.WithRelativeTo(root),
		configdiscovery.WithWarningHandler(func(message string) {
			fmt.Fprintln(os.Stderr, message)
		}),
	}
	opts = append(opts, translate(parsed)...)

	result, err := configdiscovery.Load(*packageName, opts...)
	if err != nil {
		var configError *configdiscovery.ConfigError
		if errors.As(err, &configError) {
			emitError(os.Stdout, configError, root)
			return 1
		}
		fmt.Fprintln(os.Stderr, err)
		return 2
	}

	// An encoder with HTML escaping off, so the <env> and <defaults> labels appear as written
	// rather than as \u003cenv\u003e. The runner would decode either, but a document a human
	// reads while debugging should not need decoding.
	if err := writeJSON(os.Stdout, result); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	return 0
}

// writeJSON emits one compact JSON document with no HTML escaping and no trailing newline.
// json.Marshal renders int64(5432) and float64(5432) alike as 5432, with no decimal point -
// which is what the fixtures require, and worth knowing rather than assuming.
func writeJSON(out io.Writer, value any) error {
	encoder := json.NewEncoder(out)
	encoder.SetEscapeHTML(false)
	return encoder.Encode(value)
}

func translate(o probeOptions) []configdiscovery.Option {
	var opts []configdiscovery.Option
	if o.Strategy != nil {
		opts = append(opts, configdiscovery.WithStrategy(*o.Strategy))
	}
	if o.ArrayMerge != nil {
		opts = append(opts, configdiscovery.WithArrayMerge(*o.ArrayMerge))
	}
	if o.StopDir != nil {
		opts = append(opts, configdiscovery.WithStopDir(*o.StopDir))
	}
	if o.EnvPrefix != nil {
		opts = append(opts, configdiscovery.WithEnvPrefix(*o.EnvPrefix))
	}
	if o.Profile != nil {
		opts = append(opts, configdiscovery.WithProfile(*o.Profile))
	}
	if o.Strict != nil {
		opts = append(opts, configdiscovery.WithStrict(*o.Strict))
	}
	if o.Defaults != nil {
		opts = append(opts, configdiscovery.WithDefaults(o.Defaults))
	}
	if o.Overrides != nil {
		opts = append(opts, configdiscovery.WithOverrides(o.Overrides))
	}
	return opts
}

func emitError(out io.Writer, err *configdiscovery.ConfigError, fixtureRoot string) {
	payload := map[string]any{"kind": string(err.Kind), "message": err.Error()}
	if err.Path != "" {
		payload["path"] = relativize(err.Path, fixtureRoot)
	}
	if err.KeyPath != "" {
		payload["keyPath"] = err.KeyPath
	}
	if err := writeJSON(out, map[string]any{"error": payload}); err != nil {
		fmt.Fprintln(os.Stderr, err)
	}
}

func relativize(path, fixtureRoot string) string {
	if !filepath.IsAbs(path) {
		return path
	}
	relative, err := filepath.Rel(fixtureRoot, path)
	if err != nil || strings.HasPrefix(relative, "..") {
		return filepath.ToSlash(path)
	}
	return filepath.ToSlash(relative)
}
