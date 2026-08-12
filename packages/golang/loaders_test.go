package configdiscovery

import (
	"encoding/json"
	"path/filepath"
	"reflect"
	"testing"
)

var oneOfEverything = map[string]string{
	"c/config.toml":  "from_toml = true\nlogLevel = \"debug\"\n[Nested]\nCamelKey = 1\n",
	"c/config.yaml":  "from_yaml: true\n",
	"c/config.json":  `{"from_json": true}` + "\n",
	"c/config.jsonc": "// a comment\n{\"from_jsonc\": true /* inline */}\n",
	"c/config.ini":   "[Section]\nport = 5432\nname = local\n",
	"c/.env":         "FROM__DOTENV=true\nPORT=\"5432\"\n",
}

func TestListConfigFilesOrder(t *testing.T) {
	root := tree(t, oneOfEverything)
	files, err := listConfigFiles(filepath.Join(root, "c"), "")
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, ref := range files {
		names = append(names, filepath.Base(ref.path))
	}
	want := []string{"config.toml", "config.yaml", "config.json", "config.jsonc", "config.ini", ".env"}
	if !reflect.DeepEqual(names, want) {
		t.Fatalf("got %v, want %v", names, want)
	}
}

func TestListConfigFilesDuplicateFormat(t *testing.T) {
	root := tree(t, map[string]string{"c/config.yaml": "a: 1\n", "c/config.yml": "a: 2\n"})
	_, err := listConfigFiles(filepath.Join(root, "c"), "")
	if !IsKind(err, KindDuplicateFormat) {
		t.Fatalf("expected duplicate-format, got %v", err)
	}
}

func TestListConfigFilesProfile(t *testing.T) {
	root := tree(t, map[string]string{"c/config.toml": "a = 1\n", "c/config.prod.toml": "a = 2\n"})
	files, err := listConfigFiles(filepath.Join(root, "c"), "prod")
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 2 || filepath.Base(files[1].path) != "config.prod.toml" {
		t.Fatalf("expected the profile file immediately after its base, got %v", files)
	}
}

func TestLoadOneEveryRecognizedName(t *testing.T) {
	root := tree(t, oneOfEverything)
	files, err := listConfigFiles(filepath.Join(root, "c"), "")
	if err != nil {
		t.Fatal(err)
	}
	merged := map[string]any{}
	for _, ref := range files {
		value, err := loadOne(ref, "MYTOOL")
		if err != nil {
			t.Fatalf("%s: %v", ref.path, err)
		}
		for key, item := range value {
			merged[key] = item
		}
	}

	want := map[string]any{
		"from_toml": true,
		// The assertion this whole file exists for: Viper's key store would have returned
		// "loglevel" and "nested.camelkey".
		"logLevel":   "debug",
		"Nested":     map[string]any{"CamelKey": int64(1)},
		"from_yaml":  true,
		"from_json":  true,
		"from_jsonc": true,
		// INI arrives untyped, so SPEC section 2.5's coercion applies - and the section name
		// keeps its case.
		"Section": map[string]any{"port": int64(5432), "name": "local"},
		"from":    map[string]any{"dotenv": true},
		// SPEC section 4.6: a value written inside quotes stays a string.
		"port": "5432",
	}
	if !reflect.DeepEqual(merged, want) {
		t.Fatalf("got %#v\nwant %#v", merged, want)
	}
}

func TestLoadOneMalformedTOMLCarriesPosition(t *testing.T) {
	root := tree(t, map[string]string{"c/config.toml": "[log\nlevel = \n"})
	path := filepath.Join(root, "c/config.toml")
	_, err := loadOne(fileRef{path: path, format: "toml"}, "MYTOOL")
	if !IsKind(err, KindMalformed) {
		t.Fatalf("expected malformed, got %v", err)
	}
	var configError *ConfigError
	if !asConfigError(err, &configError) {
		t.Fatal("expected a *ConfigError")
	}
	if configError.Path != path {
		t.Fatalf("path: got %q, want %q", configError.Path, path)
	}
	if configError.Line != 1 {
		t.Fatalf("line: got %d, want 1", configError.Line)
	}
}

func TestLoadOneReadFailureIsUnreadable(t *testing.T) {
	// A directory where a file is expected: a read failure, not a parse one. chmod 000 is not a
	// portable way to express this - an inherited ACL or a privileged user makes it a no-op.
	root := tree(t, map[string]string{"c/config.toml/": ""})
	_, err := loadOne(fileRef{path: filepath.Join(root, "c/config.toml"), format: "toml"}, "MYTOOL")
	if !IsKind(err, KindUnreadable) {
		t.Fatalf("expected unreadable, got %v", err)
	}
}

func TestLoadOneEmptyFile(t *testing.T) {
	root := tree(t, map[string]string{"c/config.toml": "\n# nothing but a comment\n"})
	value, err := loadOne(fileRef{path: filepath.Join(root, "c/config.toml"), format: "toml"}, "MYTOOL")
	if err != nil || len(value) != 0 {
		t.Fatalf("got %v, %v; want an empty map and no error", value, err)
	}
}

func TestLoadOneNonObjectTopLevel(t *testing.T) {
	root := tree(t, map[string]string{"c/config.json": "[1, 2, 3]\n"})
	_, err := loadOne(fileRef{path: filepath.Join(root, "c/config.json"), format: "json"}, "MYTOOL")
	if !IsKind(err, KindMalformed) {
		t.Fatalf("expected malformed, got %v", err)
	}
}

func TestNumericParityAcrossSources(t *testing.T) {
	// A 5432 from a file and a 5432 from an environment variable must be the same Go value.
	// Without canonicalNumber they are int64 and float64 respectively.
	root := tree(t, map[string]string{
		"c/config.toml": "port = 5432\n",
		"c/config.json": `{"port": 5432}` + "\n",
	})
	fromTOML, err := loadOne(fileRef{path: filepath.Join(root, "c/config.toml"), format: "toml"}, "MYTOOL")
	if err != nil {
		t.Fatal(err)
	}
	fromJSON, err := loadOne(fileRef{path: filepath.Join(root, "c/config.json"), format: "json"}, "MYTOOL")
	if err != nil {
		t.Fatal(err)
	}
	fromEnv := envLayer(map[string]string{"MYTOOL_PORT": "5432"}, "MYTOOL", nil)

	if !reflect.DeepEqual(fromTOML["port"], fromEnv["port"]) {
		t.Fatalf("toml %#v != env %#v", fromTOML["port"], fromEnv["port"])
	}
	if !reflect.DeepEqual(fromJSON["port"], fromEnv["port"]) {
		t.Fatalf("json %#v != env %#v", fromJSON["port"], fromEnv["port"])
	}

	// And it still marshals without a decimal point, which is what the fixtures compare.
	encoded, err := json.Marshal(fromEnv)
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != `{"port":5432}` {
		t.Fatalf("got %s", encoded)
	}
}

func TestParseDotenv(t *testing.T) {
	got, err := parseDotenv("# comment\nexport MYTOOL_LOG__LEVEL=trace\nA=\"5432\"\nB=5432\n", "MYTOOL", "x")
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]any{
		"log": map[string]any{"level": "trace"},
		"a":   "5432",
		"b":   int64(5432),
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v, want %#v", got, want)
	}
}

func TestStripJSONComments(t *testing.T) {
	got := stripJSONComments(`{"a": "http://not-a-comment", /* x */ "b": 1} // trailing`)
	if got != `{"a": "http://not-a-comment",  "b": 1} ` {
		t.Fatalf("got %q", got)
	}
}
