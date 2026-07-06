-- First-boot bootstrap for the shared Postgres cluster.
--
-- The official postgres image auto-creates exactly one database (POSTGRES_DB).
-- Interbox and Aidbox are peers, each owning its own database in the one cluster,
-- so we create both explicitly here. Neither app issues CREATE DATABASE itself —
-- they connect to an existing database and build their schema inside it.
--
-- initdb runs this once, only when the data directory is empty (fresh volume).
CREATE DATABASE interbox;
CREATE DATABASE aidbox;
