from flask_sqlalchemy import SQLAlchemy

# Shared SQLAlchemy instance for this POC's two modules (auth_engine, ticket_engine). Neither
# module owns it, and deliberately lives outside both packages: a real host app would point
# both modules at its own existing `db` object instead of this one, and putting it here (not
# inside either package) means neither has to import the other's internals just to share one
# db instance -- ticket_engine references auth_engine.User only by table/class name (see
# ticket_engine/models.py), never the other way around.
db = SQLAlchemy()


def upgrade_schema():
    """Tiny forward-only migration: db.create_all() creates missing *tables* but never adds
    new *columns* to tables that already exist, so an existing database/ticket_engine.db
    would crash on the first query touching a newly-added field. This adds any model column
    missing from its live table via ALTER TABLE ADD COLUMN (nullable, or with the column's
    server_default) -- enough for this POC's additive changes; a real app would use Alembic.
    Call inside an app context, after db.create_all()."""
    from sqlalchemy import inspect, text

    inspector = inspect(db.engine)
    with db.engine.begin() as conn:
        for table in db.metadata.sorted_tables:
            if not inspector.has_table(table.name):
                continue
            existing = {c['name'] for c in inspector.get_columns(table.name)}
            for column in table.columns:
                if column.name in existing:
                    continue
                col_type = column.type.compile(dialect=db.engine.dialect)
                ddl = f'ALTER TABLE "{table.name}" ADD COLUMN "{column.name}" {col_type}'
                if column.server_default is not None:
                    ddl += f' DEFAULT {column.server_default.arg}'
                conn.execute(text(ddl))
