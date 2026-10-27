-- /health/ready checks that the schema this build needs is applied (docs/06).
GRANT SELECT ON app.schema_migrations TO dr_app_runtime;
