// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

contract SmartLiving {
    enum Status { Pending, Active, Inspection, Disputed, Settled, Cancelled }

    struct Property {
        address owner;
        string name;
        uint256 rent;
        uint256 deposit;
        uint256 currentAgreement;
    }

    struct Agreement {
        uint256 propertyId;
        address tenant;
        uint64 start;
        uint64 end;
        string terms;
        bool ownerConfirmed;
        bool tenantConfirmed;
        Status status;
        uint256 escrow;
        uint256 deduction;
        string inspection;
        string disputeReason;
        string decision;
    }

    struct Payment {
        uint256 amount;
        uint256 timestamp;
    }

    address public immutable arbitrator;
    uint256 public propertyCount;
    uint256 public agreementCount;
    mapping(uint256 => Property) private properties;
    mapping(uint256 => Agreement) private agreements;
    mapping(uint256 => Payment[]) private payments;
    mapping(address => uint256) public credits;

    event PropertyRegistered(uint256 indexed id, address indexed owner);
    event AgreementCreated(uint256 indexed id, uint256 indexed propertyId, address indexed tenant);
    event AgreementConfirmed(uint256 indexed id, address indexed party);
    event AgreementCancelled(uint256 indexed id);
    event DepositReceived(uint256 indexed id, uint256 amount);
    event RentPaid(uint256 indexed id, uint256 installment, uint256 amount);
    event InspectionSubmitted(uint256 indexed id, uint256 deduction, string reason);
    event DisputeOpened(uint256 indexed id, address indexed party, string reason);
    event DepositSettled(uint256 indexed id, uint256 refund, uint256 deduction, string decision);
    event CreditWithdrawn(address indexed recipient, uint256 amount);

    constructor(address disputeArbitrator) {
        require(disputeArbitrator != address(0), "Invalid arbitrator");
        arbitrator = disputeArbitrator;
    }

    function registerProperty(string calldata name, uint256 rent, uint256 deposit) external {
        require(msg.sender != arbitrator, "Arbitrator cannot be a party");
        require(bytes(name).length > 0 && rent > 0 && deposit > 0, "Invalid property");
        uint256 id = ++propertyCount;
        properties[id] = Property(msg.sender, name, rent, deposit, 0);
        emit PropertyRegistered(id, msg.sender);
    }

    function createAgreement(uint256 propertyId, address tenant, uint64 start, uint64 end, string calldata terms) external {
        Property storage p = properties[propertyId];
        require(msg.sender == p.owner, "Owner only");
        require(p.currentAgreement == 0, "Property has an open agreement");
        require(tenant != address(0) && tenant != p.owner && tenant != arbitrator, "Invalid tenant");
        require(end > start && end > block.timestamp && bytes(terms).length > 0, "Invalid dates or terms");
        uint256 id = ++agreementCount;
        Agreement storage a = agreements[id];
        a.propertyId = propertyId;
        a.tenant = tenant;
        a.start = start;
        a.end = end;
        a.terms = terms;
        p.currentAgreement = id;
        emit AgreementCreated(id, propertyId, tenant);
    }

    function confirmAgreement(uint256 id) external {
        Agreement storage a = agreements[id];
        require(a.propertyId != 0 && a.status == Status.Pending && block.timestamp < a.end, "Confirmation unavailable");
        if (msg.sender == properties[a.propertyId].owner) {
            require(!a.ownerConfirmed, "Already confirmed");
            a.ownerConfirmed = true;
        } else {
            require(msg.sender == a.tenant, "Tenant only");
            require(!a.tenantConfirmed, "Already confirmed");
            a.tenantConfirmed = true;
        }
        emit AgreementConfirmed(id, msg.sender);
    }

    function cancelAgreement(uint256 id) external {
        Agreement storage a = agreements[id];
        Property storage p = properties[a.propertyId];
        require(msg.sender == p.owner || msg.sender == a.tenant, "Parties only");
        require(a.status == Status.Pending, "Only unfunded agreements");
        require(!(a.ownerConfirmed && a.tenantConfirmed) || block.timestamp >= a.end, "Confirmed agreement has not expired");
        a.status = Status.Cancelled;
        p.currentAgreement = 0;
        emit AgreementCancelled(id);
    }

    function depositSecurity(uint256 id) external payable {
        Agreement storage a = agreements[id];
        require(msg.sender == a.tenant, "Tenant only");
        require(a.status == Status.Pending && a.ownerConfirmed && a.tenantConfirmed && block.timestamp < a.end, "Deposit unavailable");
        require(msg.value == properties[a.propertyId].deposit, "Incorrect deposit");
        a.escrow = msg.value;
        a.status = Status.Active;
        emit DepositReceived(id, msg.value);
    }

    function payRent(uint256 id) external payable {
        Agreement storage a = agreements[id];
        Property storage p = properties[a.propertyId];
        require(msg.sender == a.tenant, "Tenant only");
        require(a.status == Status.Active && block.timestamp >= a.start && block.timestamp < a.end, "Outside rental period");
        require(msg.value == p.rent, "Incorrect rent");
        payments[id].push(Payment(msg.value, block.timestamp));
        credits[p.owner] += msg.value;
        emit RentPaid(id, payments[id].length, msg.value);
    }

    function submitInspection(uint256 id, uint256 deduction, string calldata reason) external {
        Agreement storage a = agreements[id];
        require(msg.sender == properties[a.propertyId].owner, "Owner only");
        require(a.status == Status.Active && block.timestamp >= a.end, "Inspection unavailable");
        require(deduction <= a.escrow && bytes(reason).length > 0, "Invalid deduction or reason");
        a.deduction = deduction;
        a.inspection = reason;
        a.status = Status.Inspection;
        emit InspectionSubmitted(id, deduction, reason);
    }

    function approveRefund(uint256 id) external {
        Agreement storage a = agreements[id];
        require(msg.sender == a.tenant && a.status == Status.Inspection, "Tenant approval unavailable");
        settle(id, a, a.deduction, a.inspection);
    }

    function openDispute(uint256 id, string calldata reason) external {
        Agreement storage a = agreements[id];
        require(msg.sender == a.tenant || msg.sender == properties[a.propertyId].owner, "Parties only");
        require(block.timestamp >= a.end && (a.status == Status.Active || a.status == Status.Inspection), "Dispute unavailable");
        require(bytes(reason).length > 0, "Reason required");
        a.disputeReason = reason;
        a.status = Status.Disputed;
        emit DisputeOpened(id, msg.sender, reason);
    }

    function resolveDispute(uint256 id, uint256 deduction, string calldata decision) external {
        Agreement storage a = agreements[id];
        require(msg.sender == arbitrator, "Arbitrator only");
        require(a.status == Status.Disputed, "No open dispute");
        require(deduction <= a.escrow && bytes(decision).length > 0, "Invalid deduction or decision");
        settle(id, a, deduction, decision);
    }

    function settle(uint256 id, Agreement storage a, uint256 deduction, string memory decision) private {
        Property storage p = properties[a.propertyId];
        uint256 refund = a.escrow - deduction;
        a.escrow = 0;
        a.deduction = deduction;
        a.decision = decision;
        a.status = Status.Settled;
        p.currentAgreement = 0;
        credits[a.tenant] += refund;
        credits[p.owner] += deduction;
        emit DepositSettled(id, refund, deduction, decision);
    }

    function withdraw() external {
        uint256 amount = credits[msg.sender];
        require(amount > 0, "No credit");
        credits[msg.sender] = 0;
        (bool sent, ) = payable(msg.sender).call{value: amount}("");
        require(sent, "Transfer failed");
        emit CreditWithdrawn(msg.sender, amount);
    }

    function getProperty(uint256 id) external view returns (Property memory) {
        require(id > 0 && id <= propertyCount, "Property not found");
        return properties[id];
    }

    function getAgreement(uint256 id) external view returns (Agreement memory) {
        require(id > 0 && id <= agreementCount, "Agreement not found");
        return agreements[id];
    }

    function paymentCount(uint256 id) external view returns (uint256) {
        return payments[id].length;
    }

    function getPayment(uint256 id, uint256 index) external view returns (Payment memory) {
        return payments[id][index];
    }
}
