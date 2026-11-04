-- 007: the app no longer needs a licence file, so the table that held it goes. Earlier rows in
-- `audit` stay: they are the record of what happened.

drop table if exists licence;
