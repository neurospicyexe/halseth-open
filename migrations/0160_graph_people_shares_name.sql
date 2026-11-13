-- 0160_graph_people_shares_name.sql -- a person whose name is also a character's
--
-- WHY. Some people carry names that are also characters (a member named for a film character, while
-- that film is on). The people lane (rebuild lane l) matched an entry's LABEL bare, so listing the
-- shared name would link every line about the film to the person. Suppressing by context (rows
-- written during the film, rows naming the title) was rejected: the person is most likely to be
-- present DURING the film, so that rule would drop exactly the true links, and it is the graph
-- guessing, which 0149 forbids.
--
-- RULE. shares_name_with set (free text: the work(s) the name also belongs to) = the label is NOT
-- matched bare. Only the entry's other spellings link ("<owner>'s <name>", "<name> (<owner>)"), which
-- are exact, case-sensitive and word-bounded as before. The label stays as the readable name on the
-- map. NULL = unchanged behaviour (label matched). Applied in people.ts spellingsOf, so the matcher,
-- the ambiguity check and Hearth all agree.

ALTER TABLE graph_people ADD COLUMN shares_name_with TEXT;
