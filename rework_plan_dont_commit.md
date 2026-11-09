 ● Reworked plan — GitHub ↔ IPFS/libp2p (awareness items integrated)                                                               
                                                                                                                                   
   Phase 1 — Rosetta table rework (docs modal)                                                                                     
   Full GitHub ↔ IPFS/libp2p mapping, including the newly called-out rows: Star→pin (+remote pin), Fork→re-provide same CID,       
   Contributors→provider records, Branches/tags→IPNS, Issues/PRs→gossipsub subtopics, and honest gaps (history/blame, Actions,     
   search).                                                                                                                        
                                                                                                                                   
   Phase 2 — Presence & cheap wins                                                                                                 
   • Contributors section: findProviders(rootCID) (delegated routing) lists peers holding the repo — rendered in the sidebar.      
   • Fork action: share-link framed as fork + pin (your node re-seeds the identical CID).                                          
   • Releases rows: tag → CAR artifact → root CID.                                                                                 
   • Connection tagging: clone peers tagged via connectionManager.tagPeer so the pruner never drops them (root-fix for the A-sees-B
     flakiness).                                                                                                                   
   • Pubsub peer discovery: enable topic-based discovery on repo-gossip:* — clones find each other without a share link (the       
     lobby).                                                                                                                       
                                                                                                                                   
   Phase 3 — Social topics                                                                                                         
   Issues/PR subtopics (repo-gossip:<repo>:issues) with minimal folds; requires solving clone message propagation (mesh graft —    
   tagging + direct-peer treatment in Phase 2 should fix it).                                                                      
                                                                                                                                   
   Phase 4 — Mutable names (branches)                                                                                              
   IPNS pointer for main + IPNS-over-pubsub so branch updates propagate live.                                                      
                                                                                                                                   
   Phase 5 — Storage & trust                                                                                                       
   • Pinning Services API: "Star → remote pin" with a user-supplied PSA token (Pinata/web3.storage) — star without a local Kubo.   
   • Trustless gateway links: ?format=car URLs in share options — verifiable clones, no gateway trust.                             
                                                                                                                                   
   Phase 6 — Identity & metadata                                                                                                   
   • Signed dag-json metadata block (topics, description) published with the root CID, verifiable by publisher key.                
   • DNSLink docs: custom domain → IPNS → repo CID.                                                                                
                                                                                                                                   
   Phase 7 — Tests + docs for all of the above.                                                                                    
                                                                                                                                   
   Still gaps (by design, flagged in the table): commit history/blame (needs a signed append-only log — say the word and I'll spec 
   it), Actions/CI, code search.                                                                                                   
                                                                                                                                   
   Say go and I'll start at Phase 1.                                                                                               
 
 ❯ sort in order of protocol needed to implement                                                                                   
 
 ● The user wants the plan re-sorted "in order of protocol needed to implement" — i.e., order the phases by protocol/dependency    
   stack: what each phase requires at the protocol level, so foundational protocols come first. Dependencies:                      
                                                                                                                                   
   - gossipsub (pubsub) — already enabled; needed by: presence, pubsub peer discovery, social topics, IPNS-over-pubsub.            
   - connection manager tagging — libp2p core API (no new protocol).                                                               
   - delegated routing v1 HTTP — already used; needed by Contributors.                                                             
   - IPNS — needs IPNS publishing (key management in helia: `helia.ipns` API? browser IPNS publishing is hard — keys +             
   republishing; IPNS-over-pubsub helps distribution).                                                                             
   - Pinning Services API — plain HTTPS REST (PSA spec).                                                                           
   - Trustless gateways — plain HTTPS (no p2p).                                                                                    
   - Signed dag-json metadata — IPLD codecs + signing (no new protocol; uses libp2p crypto keys).                                  
   - DNSLink — DNS TXT (docs only).                                                                                                
                                                                                                                                   
   "Order of protocol needed": stack from core-libp2p primitives outward:                                                          
   1. **libp2p core** (no new protocol): connection tagging, direct peers — foundations everything else rides on.                  
   2. **gossipsub** (have it; fix mesh): pubsub peer discovery, presence robustness → message propagation.                         
   3. **Delegated routing v1** (have it): Contributors.                                                                            
   4. **IPNS (+IPNS-over-pubsub)**: mutable names.                                                                                 
   5. **Pinning Services API** (HTTPS): remote star.                                                                               
   6. **Trustless gateway HTTP** (CAR): verifiable clone links.                                                                    
   7. **IPLD dag-json + signing**: metadata block.                                                                                 
   8. **DNSLink**: docs.                                                                                                           
                                                                                                                                   
   Re-present the plan in that order, mapping each phase to the protocol it needs.                                                 
 
 ● Plan — ordered by protocol stack (foundations first)                                                                            
                                                                                                                                   
   Phase 1 — libp2p core (no new protocol; APIs only)                                                                              
   Connection tagging (connectionManager.tagPeer) for clone peers + direct-peer treatment. This is the substrate: it stops the     
   pruner from dropping exactly the peers every later phase depends on, and likely fixes clone message propagation on its own.     
   Unblocks: everything.                                                                                                           
                                                                                                                                   
   Phase 2 — gossipsub (protocol already enabled; fix mesh)                                                                        
   Re-announce ✓ done; now harden: pubsub-based peer discovery on the repo topic, reliable mesh between tagged clone peers.        
   Unblocks: presence at scale, social, IPNS-over-pubsub.                                                                          
                                                                                                                                   
   Phase 3 — Delegated Routing v1 HTTP (protocol already used)                                                                     
   Contributors section: provider-record queries for the root CID. Pure client work against delegated-ipfs.dev. Unblocks: social   
   proof, fork discovery.                                                                                                          
                                                                                                                                   
   Phase 4 — IPNS (new protocol work) + IPNS-over-pubsub (rides Phase 2)                                                           
   Mutable main pointer, pubsub distribution for instant branch updates. Hardest protocol piece; key handling in-browser. Unblocks:
   branches/tags, DNSLink.                                                                                                         
                                                                                                                                   
   Phase 5 — Trustless Gateway HTTP (plain HTTPS; no p2p)                                                                          
   ?format=car verifiable clone links in share options. Independent of Phases 1-4, but cheap — can slot in anytime after Phase 3.  
                                                                                                                                   
   Phase 6 — Pinning Services API (plain HTTPS REST)                                                                               
   "Star → remote pin" with a user token. Independent client work.                                                                 
                                                                                                                                   
   Phase 7 — IPLD (dag-json + libp2p signing)                                                                                      
   Signed metadata block (topics/description) published with the root CID. No new network protocol — codec + crypto.               
                                                                                                                                   
   Phase 8 — DNSLink (DNS TXT; docs only)                                                                                          
   Custom domain → IPNS → repo CID. Needs Phase 4's IPNS to mean anything.                                                         
                                                                                                                                   
   Phase 9 — Social topics (gossipsub subtopics) — after Phase 2 proves message propagation.                                       
                                                                                                                                   
   Each phase: implement → verify → commit (snapshot) → release on your word. Say go.                                              
 
 ❯ use this list                                                                                                                   
 

