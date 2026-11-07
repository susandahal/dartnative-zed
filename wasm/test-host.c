// Minimal stand-in for Zed's extension host: loads extension.wasm in wasmtime 48
// (the runtime Zed uses), provides the imports a DartNative extension needs,
// lends a borrowed `worktree` handle like Zed does, and calls the exports.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wasi.h>
#include <wasmtime.h>

#define CHECK(e)                                                       \
  do {                                                                 \
    wasmtime_error_t *_e = (e);                                        \
    if (_e) {                                                          \
      wasm_name_t m;                                                   \
      wasmtime_error_message(_e, &m);                                  \
      fprintf(stderr, "FAIL %s:%d: %.*s\n", __FILE__, __LINE__, (int)m.size, m.data); \
      exit(1);                                                         \
    }                                                                  \
  } while (0)

static int failures = 0;

static void set_string(wasmtime_component_val_t *v, const char *s) {
  v->kind = WASMTIME_COMPONENT_STRING;
  wasm_byte_vec_new(&v->of.string, strlen(s), s);
}

static void print_val(const wasmtime_component_val_t *v, int depth) {
  switch (v->kind) {
  case WASMTIME_COMPONENT_STRING: printf("\"%.*s\"", (int)v->of.string.size, v->of.string.data); break;
  case WASMTIME_COMPONENT_U64: printf("%llu", (unsigned long long)v->of.u64); break;
  case WASMTIME_COMPONENT_OPTION:
    if (v->of.option) { printf("some("); print_val(v->of.option, depth + 1); printf(")"); } else printf("none");
    break;
  case WASMTIME_COMPONENT_RESULT:
    printf(v->of.result.is_ok ? "ok(" : "err(");
    if (v->of.result.val) print_val(v->of.result.val, depth + 1);
    printf(")");
    break;
  case WASMTIME_COMPONENT_LIST:
    printf("[");
    for (size_t i = 0; i < v->of.list.size; i++) { if (i) printf(", "); print_val(&v->of.list.data[i], depth + 1); }
    printf("]");
    break;
  case WASMTIME_COMPONENT_TUPLE:
    printf("(");
    for (size_t i = 0; i < v->of.tuple.size; i++) { if (i) printf(", "); print_val(&v->of.tuple.data[i], depth + 1); }
    printf(")");
    break;
  case WASMTIME_COMPONENT_RECORD:
    printf("{");
    for (size_t i = 0; i < v->of.record.size; i++) {
      if (i) printf(", ");
      printf("%.*s: ", (int)v->of.record.data[i].name.size, v->of.record.data[i].name.data);
      print_val(&v->of.record.data[i].val, depth + 1);
    }
    printf("}");
    break;
  default: printf("<kind %d>", v->kind);
  }
}

// ---- host imports -------------------------------------------------------

static wasmtime_error_t *worktree_id(void *d, wasmtime_context_t *cx, const wasmtime_component_func_type_t *t,
                                     wasmtime_component_val_t *args, size_t na, wasmtime_component_val_t *res, size_t nr) {
  wasmtime_component_resource_host_t *h = NULL;
  wasmtime_error_t *e = wasmtime_component_resource_any_to_host(cx, args[0].of.resource, &h);
  if (e) return e;
  res[0].kind = WASMTIME_COMPONENT_U64;
  res[0].of.u64 = 1000 + wasmtime_component_resource_host_rep(h);
  wasmtime_component_resource_host_delete(h);
  return NULL;
}

static wasmtime_error_t *get_settings(void *d, wasmtime_context_t *cx, const wasmtime_component_func_type_t *t,
                                      wasmtime_component_val_t *args, size_t na, wasmtime_component_val_t *res, size_t nr) {
  printf("  host: get-settings(");
  print_val(&args[0], 0); printf(", "); print_val(&args[1], 0); printf(", "); print_val(&args[2], 0);
  printf(")\n");
  wasmtime_component_val_t s;
  set_string(&s, "{\"binary\":null,\"initialization_options\":{\"enable\":\"always\"},\"settings\":null}");
  res[0].kind = WASMTIME_COMPONENT_RESULT;
  res[0].of.result.is_ok = true;
  res[0].of.result.val = wasmtime_component_val_new(&s);
  return NULL;
}

static wasmtime_error_t *node_binary_path(void *d, wasmtime_context_t *cx, const wasmtime_component_func_type_t *t,
                                          wasmtime_component_val_t *args, size_t na, wasmtime_component_val_t *res, size_t nr) {
  wasmtime_component_val_t s;
  set_string(&s, "F:\\dev\\nodejs\\node.exe");
  res[0].kind = WASMTIME_COMPONENT_RESULT;
  res[0].of.result.is_ok = true;
  res[0].of.result.val = wasmtime_component_val_new(&s);
  return NULL;
}

static wasmtime_error_t *drop_resource(void *d, wasmtime_context_t *cx, uint32_t rep) { return NULL; }

#define call(n,a,c) call_n(n,a,c,1)
// ---- calling exports ------------------------------------------------------

static wasmtime_component_instance_t instance;
static wasmtime_context_t *ctx;
static const wasmtime_component_t *component;

static void borrow_worktree(wasmtime_component_val_t *v, uint32_t rep) {
  wasmtime_component_resource_host_t *h = wasmtime_component_resource_host_new(true, rep, 1);
  v->kind = WASMTIME_COMPONENT_RESOURCE;
  CHECK(wasmtime_component_resource_host_to_any(ctx, h, &v->of.resource));
  wasmtime_component_resource_host_delete(h);
}

static void call_n(const char *name, wasmtime_component_val_t *args, size_t nargs, size_t nres) {
  wasmtime_component_export_index_t *idx =
      wasmtime_component_instance_get_export_index(&instance, ctx, NULL, name, strlen(name));
  if (!idx) { printf("FAIL no export %s\n", name); failures++; return; }
  wasmtime_component_func_t f;
  wasmtime_component_instance_get_func(&instance, ctx, idx, &f);
  wasmtime_component_val_t result;
  memset(&result, 0, sizeof result);
  printf("%s:\n", name);
  wasmtime_error_t *e = wasmtime_component_func_call(&f, ctx, args, nargs, &result, nres);
  if (e) {
    wasm_name_t m;
    wasmtime_error_message(e, &m);
    printf("  FAIL: %.*s\n", (int)m.size, m.data);
    failures++;
  } else if (nres) {
    printf("  -> ");
    print_val(&result, 0);
    printf("\n");
    wasmtime_component_val_delete(&result);
  } else printf("  -> ok\n");
  for (size_t i = 0; i < nargs; i++) wasmtime_component_val_delete(&args[i]);
  wasmtime_component_export_index_delete(idx);
}

int main(int argc, char **argv) {
  if (argc < 3) { fprintf(stderr, "usage: host extension.wasm workdir\n"); return 2; }
  const char *work = argv[2];

  FILE *fp = fopen(argv[1], "rb");
  fseek(fp, 0, SEEK_END);
  long len = ftell(fp);
  fseek(fp, 0, SEEK_SET);
  uint8_t *buf = malloc(len);
  fread(buf, 1, len, fp);
  fclose(fp);

  wasm_config_t *cfg = wasm_config_new();
  wasmtime_config_wasm_component_model_set(cfg, true);
  wasm_engine_t *engine = wasm_engine_new_with_config(cfg);
  wasmtime_component_t *comp;
  CHECK(wasmtime_component_new(engine, buf, len, &comp));
  component = comp;

  wasmtime_store_t *store = wasmtime_store_new(engine, NULL, NULL);
  ctx = wasmtime_store_context(store);

  // WASI set up the way Zed does it: work dir preopened as "." and by its
  // absolute path, and PWD pointing at it.
  wasi_config_t *wasi = wasi_config_new();
  wasi_config_inherit_stdout(wasi);
  wasi_config_inherit_stderr(wasi);
  wasi_config_preopen_dir(wasi, work, ".", true);
  wasi_config_preopen_dir(wasi, work, work, true);
  const char *names[] = {"PWD"};
  const char *values[] = {work};
  wasi_config_set_env(wasi, 1, names, values);
  CHECK(wasmtime_context_set_wasi(ctx, wasi));

  wasmtime_component_linker_t *linker = wasmtime_component_linker_new(engine);
  CHECK(wasmtime_component_linker_add_wasip2(linker));

  wasmtime_component_linker_instance_t *root = wasmtime_component_linker_root(linker);
  wasmtime_component_resource_type_t *wt = wasmtime_component_resource_type_new_host(1);
  wasmtime_component_resource_type_t *pt = wasmtime_component_resource_type_new_host(2);
  wasmtime_component_resource_type_t *kt = wasmtime_component_resource_type_new_host(3);
  CHECK(wasmtime_component_linker_instance_add_resource(root, "worktree", 8, wt, drop_resource, NULL, NULL));
  CHECK(wasmtime_component_linker_instance_add_resource(root, "project", 7, pt, drop_resource, NULL, NULL));
  CHECK(wasmtime_component_linker_instance_add_resource(root, "key-value-store", 15, kt, drop_resource, NULL, NULL));
  CHECK(wasmtime_component_linker_instance_add_func(root, "[method]worktree.id", 19, worktree_id, NULL, NULL));
  CHECK(wasmtime_component_linker_instance_add_func(root, "get-settings", 12, get_settings, NULL, NULL));

  const char *type_only[] = {"zed:extension/common", "zed:extension/context-server", "zed:extension/dap",
                             "zed:extension/process", "zed:extension/lsp", "zed:extension/slash-command"};
  for (size_t i = 0; i < sizeof type_only / sizeof *type_only; i++) {
    wasmtime_component_linker_instance_t *inst;
    CHECK(wasmtime_component_linker_instance_add_instance(root, type_only[i], strlen(type_only[i]), &inst));
    wasmtime_component_linker_instance_delete(inst);
  }
  wasmtime_component_linker_instance_t *nodejs;
  CHECK(wasmtime_component_linker_instance_add_instance(root, "zed:extension/nodejs", 20, &nodejs));
  CHECK(wasmtime_component_linker_instance_add_func(nodejs, "node-binary-path", 16, node_binary_path, NULL, NULL));
  wasmtime_component_linker_instance_delete(nodejs);
  wasmtime_component_linker_instance_delete(root);

  CHECK(wasmtime_component_linker_instantiate(linker, ctx, comp, &instance));
  printf("instantiated OK\n");

  call_n("init-extension", NULL, 0, 0);

  for (int round = 1; round <= 2; round++) {
    wasmtime_component_val_t a[3];
    set_string(&a[0], "dartnative");
    borrow_worktree(&a[1], 7);
    call("language-server-command", a, 2);
  }
  {
    wasmtime_component_val_t a[2];
    set_string(&a[0], "dartnative");
    borrow_worktree(&a[1], 7);
    call("language-server-initialization-options", a, 2);
  }
  {
    wasmtime_component_val_t a[2];
    set_string(&a[0], "dartnative");
    borrow_worktree(&a[1], 7);
    call("language-server-workspace-configuration", a, 2);
  }
  for (int i = 0; i < 3; i++) {
    wasmtime_component_val_t a[3];
    set_string(&a[0], "dartnative");
    set_string(&a[1], "dart");
    borrow_worktree(&a[2], 7);
    call("language-server-additional-workspace-configuration", a, 3);
  }
  {
    wasmtime_component_val_t a[3];
    set_string(&a[0], "dartnative");
    set_string(&a[1], "dart");
    borrow_worktree(&a[2], 7);
    call("language-server-additional-initialization-options", a, 3);
  }
  {
    wasmtime_component_val_t a[2];
    set_string(&a[0], "dartnative");
    a[1].kind = WASMTIME_COMPONENT_LIST;
    wasmtime_component_vallist_new_empty(&a[1].of.list);
    call("labels-for-completions", a, 2);
  }

  printf(failures ? "\n%d FAILED\n" : "\nALL CALLS OK\n", failures);
  return failures ? 1 : 0;
}
