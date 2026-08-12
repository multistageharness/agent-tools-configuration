package configdiscovery

// The functional-option surface. Every ambient input - the working directory, the home
// directory, the environment - has an option that replaces it, which is what makes the
// conformance probe and every test in this package hermetic.

type config struct {
	strategy   string
	arrayMerge string
	stopDir    string
	envPrefix  string
	profile    string
	strict     bool
	home       string
	cwd        string
	env        map[string]string
	envSet     bool
	defaults   map[string]any
	overrides  map[string]any
	relativeTo string
	warn       func(string)
}

// Option configures a Load call.
type Option func(*config)

// WithStrategy selects "layered" (the default) or "first-match" (SPEC section 3.2).
func WithStrategy(strategy string) Option { return func(c *config) { c.strategy = strategy } }

// WithArrayMerge selects "replace" (the default) or "concat" (SPEC section 4.3).
func WithArrayMerge(mode string) Option { return func(c *config) { c.arrayMerge = mode } }

// WithStopDir adds an inclusive stop condition to the upward walk (SPEC section 2.3).
func WithStopDir(dir string) Option { return func(c *config) { c.stopDir = dir } }

// WithEnvPrefix overrides the prefix for the environment layer (SPEC section 4.5).
func WithEnvPrefix(prefix string) Option { return func(c *config) { c.envPrefix = prefix } }

// WithProfile also loads config.<profile>.<ext> beside each base file (SPEC section 2.6).
func WithProfile(profile string) Option { return func(c *config) { c.profile = profile } }

// WithStrict promotes an unknown key from a warning to an error (SPEC section 5).
func WithStrict(strict bool) Option { return func(c *config) { c.strict = strict } }

// WithHome overrides the home directory the user-level root resolves under.
func WithHome(home string) Option { return func(c *config) { c.home = home } }

// WithCwd overrides the directory the upward walk starts from.
func WithCwd(cwd string) Option { return func(c *config) { c.cwd = cwd } }

// WithEnv replaces the environment the prefixed layer reads. An explicitly empty map means "no
// environment", which is different from not calling this option at all.
func WithEnv(env map[string]string) Option {
	return func(c *config) {
		c.env = env
		c.envSet = true
	}
}

// WithDefaults sets layer 0.
func WithDefaults(defaults map[string]any) Option {
	return func(c *config) { c.defaults = defaults }
}

// WithOverrides sets layer 5.
func WithOverrides(overrides map[string]any) Option {
	return func(c *config) { c.overrides = overrides }
}

// WithRelativeTo emits Source.Path relative to dir, forward-slashed. Used by the conformance
// probe; rarely useful otherwise.
func WithRelativeTo(dir string) Option { return func(c *config) { c.relativeTo = dir } }

// WithWarningHandler routes diagnostics. The default writes to stderr.
func WithWarningHandler(warn func(string)) Option { return func(c *config) { c.warn = warn } }
