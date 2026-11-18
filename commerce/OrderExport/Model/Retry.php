<?php
declare(strict_types=1);

namespace MageMinion\OrderExport\Model;

use Magento\Framework\App\ResourceConnection;

/**
 * The retry table: one row per order the ERP did not accept on the first try.
 */
class Retry
{
    private const TABLE = 'mageminion_order_export_retry';

    /**
     * @param ResourceConnection $resource
     */
    public function __construct(private readonly ResourceConnection $resource)
    {
    }

    /**
     * Store a failed first send as attempt 1.
     *
     * @param string $incrementId
     * @param string $json
     * @param string $error
     * @return void
     */
    public function add(string $incrementId, string $json, string $error): void
    {
        $this->resource->getConnection()->insertOnDuplicate(
            $this->resource->getTableName(self::TABLE),
            [
                'increment_id' => $incrementId,
                'payload' => $json,
                'attempts' => 1,
                'status' => 'pending',
                'last_error' => $error,
            ],
            ['payload', 'attempts', 'status', 'last_error']
        );
    }

    /**
     * Pending rows, oldest first.
     *
     * @param int $limit
     * @return array
     */
    public function due(int $limit = 50): array
    {
        $db = $this->resource->getConnection();
        return $db->fetchAll(
            $db->select()
                ->from(
                    $this->resource->getTableName(self::TABLE),
                    ['*', 'is_recent' => new \Zend_Db_Expr('created_at > NOW() - INTERVAL 5 MINUTE')]
                )
                ->where('status = ?', 'pending')
                ->order('entity_id')
                ->limit($limit)
        );
    }

    /**
     * Update a row after a send.
     *
     * @param int $id
     * @param int $attempts
     * @param string $status
     * @param string|null $error
     * @return void
     */
    public function mark(int $id, int $attempts, string $status, ?string $error): void
    {
        $this->resource->getConnection()->update(
            $this->resource->getTableName(self::TABLE),
            ['attempts' => $attempts, 'status' => $status, 'last_error' => $error],
            ['entity_id = ?' => $id]
        );
    }

    /**
     * Whether the order was saved (the observer runs before the save, which can fail).
     *
     * @param string $incrementId
     * @return bool
     */
    public function orderExists(string $incrementId): bool
    {
        $db = $this->resource->getConnection();
        return (bool)$db->fetchOne(
            $db->select()
                ->from($this->resource->getTableName('sales_order'), ['entity_id'])
                ->where('increment_id = ?', $incrementId)
        );
    }
}
