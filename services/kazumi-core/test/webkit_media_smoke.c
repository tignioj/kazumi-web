#include <webkit2/webkit2.h>

static int exit_status = 1;

static void checked(GObject *object, GAsyncResult *result,
                    gpointer data G_GNUC_UNUSED) {
  GError *error = NULL;
  JSCValue *value = webkit_web_view_evaluate_javascript_finish(
      WEBKIT_WEB_VIEW(object), result, &error);
  if (error != NULL) {
    g_printerr("WebKit media check failed: %s\n", error->message);
    g_error_free(error);
  } else {
    char *report = jsc_value_to_json(value, 0);
    g_print("WebKit media support: %s\n", report);
    g_free(report);
    JSCValue *supported = jsc_value_object_get_property(value, "supported");
    exit_status = jsc_value_to_boolean(supported) ? 0 : 1;
    g_object_unref(supported);
    g_object_unref(value);
  }
  gtk_main_quit();
}

static void loaded(WebKitWebView *view, WebKitLoadEvent event,
                   gpointer data G_GNUC_UNUSED) {
  if (event != WEBKIT_LOAD_FINISHED) return;
  webkit_web_view_evaluate_javascript(
      view,
      "(() => {"
      "const video = document.createElement('video');"
      "const type = 'video/mp4; codecs=\"avc1.42E01E,mp4a.40.2\"';"
      "const mp4 = video.canPlayType(type);"
      "const mse = !!window.MediaSource && MediaSource.isTypeSupported(type);"
      "return {mp4, mse, supported: !!mp4 && mse};"
      "})()",
      -1, NULL, NULL, NULL, checked, NULL);
}

static gboolean timed_out(gpointer data G_GNUC_UNUSED) {
  g_printerr("WebKit media check timed out\n");
  gtk_main_quit();
  return G_SOURCE_REMOVE;
}

int main(int argc, char **argv) {
  gtk_init(&argc, &argv);
  GtkWidget *window = gtk_window_new(GTK_WINDOW_TOPLEVEL);
  WebKitWebView *view = WEBKIT_WEB_VIEW(webkit_web_view_new());
  gtk_container_add(GTK_CONTAINER(window), GTK_WIDGET(view));
  g_signal_connect(view, "load-changed", G_CALLBACK(loaded), NULL);
  g_timeout_add_seconds(20, timed_out, NULL);
  webkit_web_view_load_html(view, "<!doctype html><title>Media check</title>",
                            "about:blank");
  gtk_main();
  gtk_widget_destroy(window);
  return exit_status;
}
