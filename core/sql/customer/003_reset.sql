-- Removes tickets submitted during rehearsals (the seed owns ids 1 to 15) and clears every reply. Run on the Customer DB.
delete from support_tickets where id > 15;
update support_tickets set reply = null;
