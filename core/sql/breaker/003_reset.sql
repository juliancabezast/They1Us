-- Empty the decision log and forget every session. Run on the Breaker DB.
truncate breaker.events;
delete from breaker.sessions;
