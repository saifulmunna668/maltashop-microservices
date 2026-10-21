#!/bin/sh
# One PostgreSQL server for the local prototype, but a SEPARATE database and login per service.
# Each login can only connect to its own database, so "database per service" (L2 p.97-98) is
# enforced, not just a convention. In production each service would get its own managed instance.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<SQL
CREATE ROLE order_svc LOGIN PASSWORD '${ORDER_DB_PASSWORD}';
CREATE ROLE payment_svc LOGIN PASSWORD '${PAYMENT_DB_PASSWORD}';
CREATE ROLE inventory_svc LOGIN PASSWORD '${INVENTORY_DB_PASSWORD}';
CREATE DATABASE orders_db OWNER order_svc;
CREATE DATABASE payments_db OWNER payment_svc;
CREATE DATABASE inventory_db OWNER inventory_svc;
REVOKE CONNECT ON DATABASE orders_db FROM PUBLIC;
REVOKE CONNECT ON DATABASE payments_db FROM PUBLIC;
REVOKE CONNECT ON DATABASE inventory_db FROM PUBLIC;
GRANT CONNECT ON DATABASE orders_db TO order_svc;
GRANT CONNECT ON DATABASE payments_db TO payment_svc;
GRANT CONNECT ON DATABASE inventory_db TO inventory_svc;
SQL
